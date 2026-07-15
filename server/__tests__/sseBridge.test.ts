import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RawHookEvent } from '../src/providers/hook/sse/sseBridge.js';
import { createSseEventPump } from '../src/providers/hook/sse/sseBridge.js';

const KEY = 'agent-123:session-abc';

function payload(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ agent_id: 'agent-123', session_id: 'session-abc', ...extra });
}

describe('createSseEventPump', () => {
  let emitted: RawHookEvent[];
  let pump: (eventName: string, data: string) => void;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitted = [];
    pump = createSseEventPump((raw) => emitted.push(raw));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  const names = () => emitted.map((e) => e.hook_event_name);

  it('adopts a session on agent.session.started and confirms it immediately', () => {
    pump('agent.session.started', payload({ name: 'Backend Engineer' }));
    expect(names()).toEqual(['agent.session.started', 'pixel-agents.session.confirm']);
    expect(emitted[0].session_id).toBe(KEY);
    expect(emitted[0].name).toBe('Backend Engineer');
    expect(emitted[1].session_id).toBe(KEY);
  });

  it('does not re-adopt an already seen session', () => {
    pump('agent.session.started', payload());
    pump('agent.session.started', payload());
    expect(names()).toEqual([
      'agent.session.started',
      'pixel-agents.session.confirm',
      'agent.session.started',
      'pixel-agents.session.confirm',
    ]);
  });

  it('auto-adopts sessions first seen mid-stream', () => {
    pump('agent.tool.started', payload({ tool: 'shell' }));
    expect(names()).toEqual([
      'agent.session.started',
      'pixel-agents.session.confirm',
      'agent.tool.started',
    ]);
  });

  it('closes the previous tool before starting a new one', () => {
    pump('agent.session.started', payload());
    pump('agent.tool.started', payload({ tool: 'shell' }));
    pump('agent.tool.started', payload({ tool: 'read' }));
    expect(names().slice(2)).toEqual([
      'agent.tool.started',
      'agent.tool.completed',
      'agent.tool.started',
    ]);
  });

  it('does not synthesize a close after an explicit tool completion', () => {
    pump('agent.session.started', payload());
    pump('agent.tool.started', payload({ tool: 'shell' }));
    pump('agent.tool.completed', payload());
    pump('agent.tool.started', payload({ tool: 'read' }));
    expect(names().slice(2)).toEqual([
      'agent.tool.started',
      'agent.tool.completed',
      'agent.tool.started',
    ]);
  });

  it('clears the open tool on turn end statuses', () => {
    pump('agent.session.started', payload());
    pump('agent.status.changed', payload({ status: 'working' }));
    pump('agent.status.changed', payload({ status: 'idle' }));
    pump('agent.status.changed', payload({ status: 'working' }));
    expect(names().slice(2)).toEqual([
      'agent.status.changed',
      'agent.status.changed',
      'agent.status.changed',
    ]);
  });

  it('drops agent.session.ended for sessions it never saw start', () => {
    // The hub emits session.ended unconditionally (its per-connection
    // translator cannot know what we saw). Adopting here would spawn a
    // character just to despawn it one event later (visible flicker).
    pump('agent.session.ended', payload());
    expect(emitted).toHaveLength(0);
  });

  it('forgets a session after agent.session.ended and re-adopts on the next event', () => {
    pump('agent.session.started', payload());
    pump('agent.session.ended', payload());
    pump('agent.message', payload({ message: 'back again' }));
    expect(names()).toEqual([
      'agent.session.started',
      'pixel-agents.session.confirm',
      'agent.session.ended',
      'agent.session.started',
      'pixel-agents.session.confirm',
      'agent.message',
    ]);
  });

  it('drops malformed JSON payloads and warns only once per event name', () => {
    pump('agent.message', 'not-json');
    pump('agent.message', '[1,2,3]');
    pump('agent.message', 'still not json');
    expect(emitted).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('drops payloads without agent or session ids', () => {
    pump('agent.message', JSON.stringify({ message: 'anonymous' }));
    expect(emitted).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown event names without crashing', () => {
    pump('agent.telemetry.heartbeat', payload());
    expect(emitted).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps concurrent sessions isolated', () => {
    pump('agent.session.started', JSON.stringify({ agent_id: 'a1', session_id: 's1' }));
    pump('agent.session.started', JSON.stringify({ agent_id: 'a2', session_id: 's2' }));
    pump('agent.tool.started', JSON.stringify({ agent_id: 'a1', session_id: 's1', tool: 'shell' }));
    pump('agent.tool.started', JSON.stringify({ agent_id: 'a2', session_id: 's2', tool: 'read' }));
    const toolEvents = emitted.filter((e) => e.hook_event_name === 'agent.tool.started');
    expect(toolEvents.map((e) => e.session_id)).toEqual(['a1:s1', 'a2:s2']);
    // No cross-session synthetic completions: each session has its own open tool.
    expect(names().filter((n) => n === 'agent.tool.completed')).toHaveLength(0);
  });
});

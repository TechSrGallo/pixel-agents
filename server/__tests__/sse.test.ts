import { describe, expect, it } from 'vitest';

import {
  normalizeSseEvent,
  routingSessionKey,
} from '../src/providers/hook/sse/normalizeSseEvent.js';
import { formatToolStatus, sseProvider } from '../src/providers/hook/sse/sse.js';

describe('routingSessionKey', () => {
  it('combines agent_id and session_id', () => {
    expect(routingSessionKey({ agent_id: 'a1', session_id: 's1' })).toBe('a1:s1');
  });

  it('falls back to whichever id is present', () => {
    expect(routingSessionKey({ agent_id: 'a1' })).toBe('a1');
    expect(routingSessionKey({ session_id: 's1' })).toBe('s1');
  });

  it('returns null when neither id is present', () => {
    expect(routingSessionKey({})).toBeNull();
    expect(routingSessionKey({ agent_id: 42 })).toBeNull();
  });
});

describe('normalizeSseEvent', () => {
  const base = { agent_id: 'agent-123', session_id: 'agent-123:session-abc' };

  const norm = (eventName: string, extra: Record<string, unknown> = {}) =>
    normalizeSseEvent({ ...base, ...extra, hook_event_name: eventName });

  it('returns null without hook_event_name or session_id', () => {
    expect(normalizeSseEvent({ session_id: 's' })).toBeNull();
    expect(normalizeSseEvent({ hook_event_name: 'agent.message' })).toBeNull();
    expect(normalizeSseEvent({ hook_event_name: 'agent.message', session_id: '' })).toBeNull();
  });

  it('returns null for unknown event names', () => {
    expect(norm('agent.unknown.event')).toBeNull();
  });

  it('maps agent.session.started to sessionStart with name and project', () => {
    const result = norm('agent.session.started', {
      name: 'Backend Engineer',
      project: '/workspace/payments-api',
    });
    expect(result?.sessionId).toBe(base.session_id);
    expect(result?.event).toEqual({
      kind: 'sessionStart',
      source: 'sse',
      cwd: '/workspace/payments-api',
      agentName: 'Backend Engineer',
    });
  });

  it('synthesizes a cwd and agentName when the payload omits them', () => {
    const result = norm('agent.session.started');
    expect(result?.event).toEqual({
      kind: 'sessionStart',
      source: 'sse',
      cwd: 'sse:agent-123',
      agentName: 'agent-123',
    });
  });

  it('maps active statuses to synthetic toolStart events', () => {
    for (const status of ['working', 'thinking', 'reading', 'editing', 'running_tool']) {
      const result = norm('agent.status.changed', { status, activity: 'doing things' });
      expect(result?.event.kind).toBe('toolStart');
      const event = result?.event as { toolName: string; input: Record<string, unknown> };
      expect(event.toolName).toBe(status);
      expect(event.input.activity).toBe('doing things');
    }
  });

  it('degrades unknown statuses to a working toolStart', () => {
    const result = norm('agent.status.changed', { status: 'quantum_flux' });
    expect(result?.event.kind).toBe('toolStart');
    expect((result?.event as { toolName: string }).toolName).toBe('working');
  });

  it('maps terminal statuses to turnEnd', () => {
    for (const status of ['idle', 'completed', 'failed']) {
      expect(norm('agent.status.changed', { status })?.event).toEqual({ kind: 'turnEnd' });
    }
  });

  it('maps waiting statuses to turnEnd(awaitingInput)', () => {
    for (const status of ['waiting_input', 'blocked']) {
      expect(norm('agent.status.changed', { status })?.event).toEqual({
        kind: 'turnEnd',
        awaitingInput: true,
      });
    }
  });

  it('maps waiting_permission status to permissionRequest', () => {
    expect(norm('agent.status.changed', { status: 'waiting_permission' })?.event).toEqual({
      kind: 'permissionRequest',
    });
  });

  it('maps agent.tool.started to toolStart with the upstream tool name', () => {
    const result = norm('agent.tool.started', { tool: 'shell', command: 'npm test' });
    expect(result?.event.kind).toBe('toolStart');
    const event = result?.event as { toolName: string; input: Record<string, unknown> };
    expect(event.toolName).toBe('shell');
    expect(event.input.command).toBe('npm test');
  });

  it('maps agent.tool.completed to toolEnd', () => {
    expect(norm('agent.tool.completed')?.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
  });

  it('maps agent.permission.requested to permissionRequest', () => {
    expect(norm('agent.permission.requested')?.event).toEqual({ kind: 'permissionRequest' });
  });

  it('maps agent.message to a message toolStart carrying the text', () => {
    const result = norm('agent.message', { message: 'I need approval' });
    expect(result?.event.kind).toBe('toolStart');
    const event = result?.event as { toolName: string; input: Record<string, unknown> };
    expect(event.toolName).toBe('message');
    expect(event.input.message).toBe('I need approval');
  });

  it('maps agent.session.completed to turnEnd (character stays)', () => {
    expect(norm('agent.session.completed', { result: 'success' })?.event).toEqual({
      kind: 'turnEnd',
    });
  });

  it('maps agent.session.ended to sessionEnd (character despawns)', () => {
    expect(norm('agent.session.ended', { result: 'success' })?.event).toEqual({
      kind: 'sessionEnd',
      reason: 'success',
    });
  });

  it('maps the internal confirm event to progress', () => {
    expect(norm('pixel-agents.session.confirm')?.event.kind).toBe('progress');
  });
});

describe('formatToolStatus', () => {
  it('prefers the message, then the activity, then the fallback label', () => {
    expect(formatToolStatus('working', { message: 'Fixing bug' })).toBe('Fixing bug');
    expect(formatToolStatus('working', { activity: 'editing' })).toBe('editing');
    expect(formatToolStatus('working')).toBe('Working');
    expect(formatToolStatus('thinking')).toBe('Thinking');
    expect(formatToolStatus('reading')).toBe('Reading');
    expect(formatToolStatus('editing')).toBe('Editing');
    expect(formatToolStatus('running_tool')).toBe('Running a tool');
    expect(formatToolStatus('message')).toBe('Sending a message');
  });

  it('shows the command for real upstream tools', () => {
    expect(formatToolStatus('shell', { command: 'npm test' })).toBe('Running: npm test');
  });

  it('falls back to Using <tool> for unknown tools without input', () => {
    expect(formatToolStatus('vector_db')).toBe('Using vector_db');
  });

  it('truncates long messages with an ellipsis', () => {
    const longMessage = 'x'.repeat(100);
    const label = formatToolStatus('working', { message: longMessage });
    expect(label.length).toBe(61);
    expect(label.endsWith('\u2026')).toBe(true);
  });
});

describe('sseProvider', () => {
  it('adopts all sessions and installs nothing', async () => {
    expect(sseProvider.id).toBe('sse');
    expect(sseProvider.adoptAllSessions).toBe(true);
    await expect(sseProvider.areHooksInstalled()).resolves.toBe(true);
    await expect(sseProvider.installHooks('http://localhost', 'token')).resolves.toBeUndefined();
    await expect(sseProvider.uninstallHooks()).resolves.toBeUndefined();
  });

  it('classifies read-like tools for the reading animation', () => {
    expect(sseProvider.readingTools.has('thinking')).toBe(true);
    expect(sseProvider.readingTools.has('read')).toBe(true);
    expect(sseProvider.readingTools.has('shell')).toBe(false);
  });
});

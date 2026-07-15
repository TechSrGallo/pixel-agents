import {
  SSE_EVENT_CONFIRM,
  SSE_EVENT_SESSION_STARTED,
  SSE_EVENT_TOOL_COMPLETED,
} from './constants.js';
import { normalizeSseEvent, routingSessionKey } from './normalizeSseEvent.js';
import { SseStreamClient } from './sseClient.js';
import type { SseBridgeConfig } from './types.js';

/** Raw hook event in the shape the AgentRuntime dispatcher expects. */
export type RawHookEvent = Record<string, unknown> & {
  hook_event_name: string;
  session_id: string;
};

/** Sink that feeds events into the runtime (cli.ts wires this to
 *  `runtime.handleHookEvent(SSE_PROVIDER_ID, raw)`). */
export type HookEventSink = (raw: RawHookEvent) => void;

/**
 * Stateful pump translating upstream SSE events into raw hook events.
 *
 * Responsibilities beyond 1:1 wrapping:
 * - Validates JSON payloads and agent/session ids; logs and drops invalid events
 *   (throttled per event name) without ever crashing the server.
 * - Emits a synthetic confirmation right after each sessionStart so the character
 *   appears immediately (the dispatcher otherwise waits for a follow-up event).
 * - Auto-adopts sessions seen mid-stream (server restarted, Last-Event-ID replay):
 *   synthesizes a sessionStart for unknown keys before forwarding their event.
 * - Keeps at most one hook-tool open per session: a new toolStart-mapped event
 *   closes the previous one so activity labels never stack.
 *
 * Pure state machine over the sink — no network. `SseStreamClient` drives it.
 */
export function createSseEventPump(emit: HookEventSink): (eventName: string, data: string) => void {
  const seenSessions = new Set<string>();
  const openToolSessions = new Set<string>();
  const warnedInvalid = new Set<string>();

  const warnOnce = (bucket: string, message: string): void => {
    if (warnedInvalid.has(bucket)) return;
    warnedInvalid.add(bucket);
    console.warn(`[Pixel Agents] SSE: ${message}`);
  };

  const adopt = (key: string, payload: Record<string, unknown>): void => {
    emit({ ...payload, hook_event_name: SSE_EVENT_SESSION_STARTED, session_id: key });
    emit({ hook_event_name: SSE_EVENT_CONFIRM, session_id: key });
    seenSessions.add(key);
  };

  return (eventName: string, data: string): void => {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('payload is not an object');
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      warnOnce(`json:${eventName}`, `dropping "${eventName}" events with malformed JSON payloads`);
      return;
    }

    const key = routingSessionKey(payload);
    if (!key) {
      warnOnce(`key:${eventName}`, `dropping "${eventName}" events without agent_id/session_id`);
      return;
    }

    const raw: RawHookEvent = { ...payload, hook_event_name: eventName, session_id: key };
    const normalized = normalizeSseEvent(raw);
    if (!normalized) {
      warnOnce(`event:${eventName}`, `ignoring unknown event "${eventName}"`);
      return;
    }

    const kind = normalized.event.kind;
    if (kind === 'sessionStart') {
      adopt(key, payload);
      return;
    }

    // A sessionEnd for a session we never saw is a no-op: adopting it would
    // spawn a character just to despawn it one event later (visible flicker).
    // The hub emits session.ended unconditionally (its translator is
    // per-connection and cannot know what we saw), so this drop is ours.
    if (kind === 'sessionEnd' && !seenSessions.has(key)) {
      return;
    }

    // Mid-stream attach: an event for a session we never saw start. Adopt it first
    // so the dispatcher doesn't silently drop the event for an unknown session.
    if (!seenSessions.has(key)) {
      adopt(key, payload);
    }

    switch (kind) {
      case 'toolStart':
        if (openToolSessions.has(key)) {
          emit({ hook_event_name: SSE_EVENT_TOOL_COMPLETED, session_id: key });
        }
        emit(raw);
        openToolSessions.add(key);
        break;
      case 'toolEnd':
        emit(raw);
        openToolSessions.delete(key);
        break;
      case 'turnEnd':
        emit(raw);
        openToolSessions.delete(key);
        break;
      case 'sessionEnd':
        emit(raw);
        openToolSessions.delete(key);
        seenSessions.delete(key);
        break;
      default:
        emit(raw);
        break;
    }
  };
}

/** Handle returned by startSseBridge. */
export interface SseBridgeHandle {
  stop: () => void;
}

/**
 * Connect to the upstream SSE endpoint and pump its events into the runtime.
 * Returns a handle whose stop() tears down the connection (used on shutdown).
 */
export function startSseBridge(config: SseBridgeConfig, sink: HookEventSink): SseBridgeHandle {
  const pump = createSseEventPump(sink);
  const client = new SseStreamClient({
    url: config.url,
    token: config.token,
    onEvent: (event) => pump(event.event, event.data),
  });
  client.start();
  return { stop: () => client.stop() };
}

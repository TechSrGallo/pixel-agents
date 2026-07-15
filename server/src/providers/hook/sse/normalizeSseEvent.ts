import type { AgentEvent } from '../../../../../core/src/provider.js';
import {
  SSE_EVENT_CONFIRM,
  SSE_EVENT_MESSAGE,
  SSE_EVENT_PERMISSION_REQUESTED,
  SSE_EVENT_SESSION_COMPLETED,
  SSE_EVENT_SESSION_ENDED,
  SSE_EVENT_SESSION_STARTED,
  SSE_EVENT_STATUS_CHANGED,
  SSE_EVENT_TOOL_COMPLETED,
  SSE_EVENT_TOOL_STARTED,
  SSE_STATUS_TOOL_NAMES,
} from './constants.js';

// ── normalizeSseEvent: the single SSE-specific normalization boundary ──
//
// Raw events reach the provider in the same wrapped shape whether they came from
// the built-in SSE bridge or from an external process POSTing to /api/hooks/sse:
//
//   { hook_event_name: '<sse event name>', session_id: '<routing key>', ...payload }
//
// `session_id` is the routing key the dispatcher uses to map events to characters.
// The built-in bridge derives it via `routingSessionKey` (agent_id + session_id);
// external POSTers may choose any stable unique key per character.
//
// Mapping table (upstream event → AgentEvent.kind):
//   agent.session.started       → sessionStart (cwd=project, agentName=name)
//   agent.status.changed        → toolStart | turnEnd | permissionRequest (per status)
//   agent.tool.started          → toolStart
//   agent.tool.completed        → toolEnd
//   agent.permission.requested  → permissionRequest
//   agent.message               → toolStart (activity label shows the message)
//   agent.session.completed     → turnEnd  (character stays, "Done"; result:
//                                 'failed' sets failed → red bubble)
//   agent.session.ended         → sessionEnd (character despawns)
//   pixel-agents.session.confirm→ progress (internal confirmation, then dropped)

/** Routing key for an upstream payload: unique per (agent, session) pair so
 *  concurrent agents/sessions each get their own character. */
export function routingSessionKey(payload: Record<string, unknown>): string | null {
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : '';
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  if (agentId && sessionId) return `${agentId}:${sessionId}`;
  return agentId || sessionId || null;
}

/** Map an `agent.status.changed` status to an AgentEvent. Unknown statuses degrade
 *  to a generic "working" toolStart so new upstream vocab never crashes the office. */
function statusToEvent(raw: Record<string, unknown>): AgentEvent {
  const status = typeof raw.status === 'string' ? raw.status : '';
  switch (status) {
    case 'idle':
    case 'completed':
      return { kind: 'turnEnd' };
    case 'failed':
      return { kind: 'turnEnd', failed: true };
    case 'waiting_input':
    case 'blocked':
      return { kind: 'turnEnd', awaitingInput: true };
    case 'waiting_permission':
      return { kind: 'permissionRequest' };
    default: {
      const toolName = SSE_STATUS_TOOL_NAMES[status] ?? 'working';
      return {
        kind: 'toolStart',
        toolId: `sse-status-${Date.now()}`,
        toolName,
        input: { activity: raw.activity, message: raw.message },
      };
    }
  }
}

export function normalizeSseEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string' || !sessionId) return null;

  switch (eventName) {
    case SSE_EVENT_SESSION_STARTED: {
      const agentId = typeof raw.agent_id === 'string' ? raw.agent_id : sessionId;
      const project = typeof raw.project === 'string' && raw.project ? raw.project : undefined;
      const name = typeof raw.name === 'string' && raw.name ? raw.name : agentId;
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: 'sse',
          // cwd doubles as the projectDir for hooks-only agents; must be truthy
          // or the dispatcher refuses to store the pending session.
          cwd: project ?? `sse:${agentId}`,
          agentName: name,
        },
      };
    }

    case SSE_EVENT_STATUS_CHANGED:
      return { sessionId, event: statusToEvent(raw) };

    case SSE_EVENT_TOOL_STARTED: {
      const toolName = typeof raw.tool === 'string' && raw.tool ? raw.tool : 'tool';
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `sse-tool-${Date.now()}`,
          toolName,
          input: { command: raw.command, message: raw.message },
        },
      };
    }

    case SSE_EVENT_TOOL_COMPLETED:
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };

    case SSE_EVENT_PERMISSION_REQUESTED:
      return { sessionId, event: { kind: 'permissionRequest' } };

    case SSE_EVENT_MESSAGE:
      // No speech-bubble message exists in the protocol; degrade to an activity
      // label (toolStart) so the message is visible above the character.
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `sse-message-${Date.now()}`,
          toolName: 'message',
          input: { message: raw.message },
        },
      };

    case SSE_EVENT_SESSION_COMPLETED:
      // Keep the character in the office showing "Done" — or the red failed
      // bubble when the upstream reports `result: 'failed'`. Upstreams that
      // want the character removed send agent.session.ended instead.
      return {
        sessionId,
        event: raw.result === 'failed' ? { kind: 'turnEnd', failed: true } : { kind: 'turnEnd' },
      };

    case SSE_EVENT_SESSION_ENDED:
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.result === 'string' ? raw.result : 'ended',
        },
      };

    case SSE_EVENT_CONFIRM:
      // Internal bridge event: confirms a pending external session (any non-session
      // event confirms), then the dispatcher silently drops `progress`.
      return { sessionId, event: { kind: 'progress', toolId: 'sse-confirm', data: raw } };

    default:
      return null;
  }
}

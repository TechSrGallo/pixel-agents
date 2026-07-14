/**
 * Wire types for the external SSE agent stream.
 *
 * These describe what the UPSTREAM agent system sends. The bridge wraps each
 * upstream event into a raw hook event ({ hook_event_name, session_id, ...payload })
 * and `normalizeSseEvent` translates that into the canonical AgentEvent union.
 */

export type ExternalSseEventName =
  | 'agent.session.started'
  | 'agent.status.changed'
  | 'agent.tool.started'
  | 'agent.tool.completed'
  | 'agent.permission.requested'
  | 'agent.message'
  | 'agent.session.completed'
  | 'agent.session.ended';

export type ExternalSseStatus =
  | 'idle'
  | 'working'
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'running_tool'
  | 'waiting_input'
  | 'waiting_permission'
  | 'blocked'
  | 'completed'
  | 'failed';

export interface ExternalSseBasePayload {
  agent_id: string;
  session_id: string;
  timestamp?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalSseSessionStartedPayload extends ExternalSseBasePayload {
  name?: string;
  role?: string;
  project?: string;
  model?: string;
}

export interface ExternalSseStatusChangedPayload extends ExternalSseBasePayload {
  status: ExternalSseStatus;
  activity?: string;
}

export interface ExternalSseToolStartedPayload extends ExternalSseBasePayload {
  tool: string;
  command?: string;
}

export interface ExternalSseToolCompletedPayload extends ExternalSseBasePayload {
  tool?: string;
  success?: boolean;
  exit_code?: number;
}

export interface ExternalSsePermissionRequestedPayload extends ExternalSseBasePayload {
  permission_id?: string;
}

export interface ExternalSseSessionCompletedPayload extends ExternalSseBasePayload {
  result?: 'success' | 'failed' | 'cancelled';
}

/** Configuration for the SSE bridge (from CLI flags / env vars). */
export interface SseBridgeConfig {
  /** Upstream SSE endpoint, e.g. http://localhost:8080/events */
  url: string;
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  token?: string;
}

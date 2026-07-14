/** Provider id: appears in POST /api/hooks/:providerId and AgentState.providerId. */
export const SSE_PROVIDER_ID = 'sse';

// ── Upstream SSE event names (the external agent system's vocabulary) ──
export const SSE_EVENT_SESSION_STARTED = 'agent.session.started';
export const SSE_EVENT_STATUS_CHANGED = 'agent.status.changed';
export const SSE_EVENT_TOOL_STARTED = 'agent.tool.started';
export const SSE_EVENT_TOOL_COMPLETED = 'agent.tool.completed';
export const SSE_EVENT_PERMISSION_REQUESTED = 'agent.permission.requested';
export const SSE_EVENT_MESSAGE = 'agent.message';
export const SSE_EVENT_SESSION_COMPLETED = 'agent.session.completed';
/** Optional upstream event: hard end of a session. Unlike `agent.session.completed`
 *  (character stays, shows "Done"), this despawns the character. */
export const SSE_EVENT_SESSION_ENDED = 'agent.session.ended';

/** Internal synthetic event emitted by the bridge right after a sessionStart so the
 *  pending external session is confirmed immediately (normalizes to `progress`,
 *  which the dispatcher drops after confirmation). Never sent by upstreams. */
export const SSE_EVENT_CONFIRM = 'pixel-agents.session.confirm';

// ── Synthetic tool names for status→animation mapping ──
// `agent.status.changed` statuses become synthetic toolStart events; the ones in
// SSE_READING_TOOLS render the "reading" character animation, the rest "typing".
export const SSE_STATUS_TOOL_NAMES: Record<string, string> = {
  working: 'working',
  thinking: 'thinking',
  reading: 'reading',
  editing: 'editing',
  running_tool: 'running_tool',
};

/** Tool names that show the reading animation. Includes the synthetic status tools
 *  plus common real tool names an upstream may send in `agent.tool.started`. */
export const SSE_READING_TOOLS: ReadonlySet<string> = new Set([
  'thinking',
  'reading',
  'read',
  'grep',
  'glob',
  'search',
  'fetch',
  'web_search',
  'websearch',
]);

// ── SSE client (transport) defaults ──
export const SSE_INITIAL_BACKOFF_MS = 1_000;
export const SSE_MAX_BACKOFF_MS = 30_000;
/** Reconnect if the stream is silent (no bytes, not even `:` heartbeats) this long. */
export const SSE_IDLE_TIMEOUT_MS = 90_000;

/** Max length of an agent.message / activity string shown as the activity label. */
export const SSE_MESSAGE_DISPLAY_MAX_LENGTH = 60;

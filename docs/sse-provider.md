# SSE Provider — visualize any agent system

The `sse` provider lets Pixel Agents visualize agents from **any external agent
platform** that emits lifecycle/activity events over Server-Sent Events. No
Claude Code required: the standalone server connects to your SSE endpoint,
normalizes events into canonical `AgentEvent`s, and the office UI renders your
agents as animated characters — same layouts, same editor, same animations.

```text
Your Agent System ──SSE──▶ SSE bridge ──AgentEvent──▶ AgentRuntime ──WS──▶ Browser SPA
```

## Quick start

```bash
npx pixel-agents --port 3100 \
  --provider sse \
  --sse-url http://localhost:8080/events \
  --sse-token <optional-bearer-token>
```

Or via environment variables:

```bash
PIXEL_AGENTS_PROVIDER=sse \
PIXEL_AGENTS_SSE_URL=http://localhost:8080/events \
PIXEL_AGENTS_SSE_TOKEN=... \
npx pixel-agents --port 3100
```

`--sse-url` alone implies `--provider sse`. Try it without a real upstream using
the bundled mock:

```bash
node scripts/mock-sse-server.mjs --port 8090          # terminal 1
node dist/cli.js --sse-url http://127.0.0.1:8090/events  # terminal 2
```

## Event vocabulary

Events are named SSE events with JSON payloads. Every payload must carry
`agent_id` and `session_id`; the pair becomes the routing key
(`<agent_id>:<session_id>`), so concurrent agents and sessions each get their
own character.

| SSE event                    | Payload fields (beyond ids)                    | Maps to                             |
| ---------------------------- | ---------------------------------------------- | ----------------------------------- |
| `agent.session.started`      | `name`, `role`, `project`, `model`, `metadata` | `sessionStart` (spawns character)   |
| `agent.status.changed`       | `status`, `activity`, `message`                | see status table below              |
| `agent.tool.started`         | `tool`, `command`, `message`                   | `toolStart` (activity label)        |
| `agent.tool.completed`       | `tool`, `success`, `exit_code`, `message`      | `toolEnd`                           |
| `agent.permission.requested` | `permission_id`, `message`                     | `permissionRequest` (red bubble)    |
| `agent.message`              | `message`                                      | `toolStart('message')` (label)      |
| `agent.session.completed`    | `result`, `message`                            | `turnEnd` (character stays, "Done") |
| `agent.session.ended`        | `result`                                       | `sessionEnd` (character despawns)   |

### Status mapping (`agent.status.changed`)

| `status`                        | Visual state                          |
| ------------------------------- | ------------------------------------- |
| `working`                       | typing animation, label "Working"     |
| `thinking`                      | reading animation, label "Thinking"   |
| `reading`                       | reading animation, label "Reading"    |
| `editing`                       | typing animation, label "Editing"     |
| `running_tool`                  | typing animation, "Running a tool"    |
| `idle` / `completed` / `failed` | turn end ("Done")                     |
| `waiting_input` / `blocked`     | "Waiting for input"                   |
| `waiting_permission`            | permission bubble                     |
| anything else                   | degrades to `working` (never crashes) |

Tool names in `agent.tool.started` that look read-like (`read`, `grep`, `glob`,
`search`, `fetch`, `web_search`) render the reading animation; everything else
types. `command` shows as `Running: <command>` above the character.

## Robustness

- **Reconnect**: exponential backoff (1s → 30s cap), reset after any delivered
  event. Honors the SSE `retry:` field. Idle streams (90s without bytes) are
  reconnected — send `:` heartbeat comments to keep the connection alive.
- **Replay**: if your upstream sends `id:` fields, the bridge resends
  `Last-Event-ID` on reconnect so you can replay missed events.
- **Auth**: `--sse-token` is sent as `Authorization: Bearer <token>`.
- **Mid-stream adoption**: events for sessions never seen starting (server
  restarted mid-run) synthesize a `sessionStart`, so characters still appear.
- **Validation**: malformed JSON, missing ids and unknown event names are
  logged (throttled, once per event name) and dropped without crashing.

## Alternative: POST bridge (no SSE endpoint needed)

The hook route accepts any provider id, so an external process can also POST
events directly instead of exposing an SSE stream — same payloads, wrapped as
hook events:

```http
POST http://127.0.0.1:3100/api/hooks/sse
Authorization: Bearer <token from ~/.pixel-agents/server.json>
Content-Type: application/json

{
  "hook_event_name": "agent.status.changed",
  "session_id": "agent-123:session-abc",
  "agent_id": "agent-123",
  "status": "working",
  "activity": "Updating payment validation"
}
```

Note: when POSTing directly you must send the wrapped shape
(`hook_event_name` + routing `session_id`) and handle session confirmation
yourself (any follow-up event confirms a pending session). The built-in SSE
bridge does all of this for you, so prefer `--sse-url` when possible.

## Adapting a foreign dialect

If your platform already exposes an SSE stream but with a different
vocabulary, don't change either side: put a small translating proxy between
them. `scripts/mi-cli-ia-sse-adapter.mjs` is a complete, dependency-free
worked example that consumes a task/message/turn-based hub dialect
(`task.created`, `message.sent`, `turn.token`, … with camelCase ids) and
re-serves it as the `agent.*` vocabulary above — full runbook in
[mi-cli-ia.md](mi-cli-ia.md):

```bash
node scripts/mi-cli-ia-sse-adapter.mjs \
  --upstream http://127.0.0.1:7088/events --upstream-token <tok> --port 7089  # terminal 1
node dist/cli.js --provider sse --sse-url http://127.0.0.1:7089/events       # terminal 2
```

Patterns it demonstrates, reusable for any dialect:

- **Stable characters**: each upstream worker becomes one persistent
  character keyed by its id (idling between tasks) instead of despawning; an
  optional synthetic "Hub" character animates orchestrator-level events
  (`--no-hub` to disable).
- **Lazy adoption**: the first event that mentions an agent emits
  `agent.session.started` for it, so mid-stream connects still spawn a cast.
- **Label hygiene**: streamed `turn.token` chunks are throttled (~1/s),
  code fences are skipped, and long messages truncated before becoming
  activity labels.
- **Own robustness**: upstream reconnect with backoff + `Last-Event-ID`, and
  a downstream replay ring buffer + session snapshot for fresh clients, so
  restarts on either side don't lose the office.

## Implementation map

| File                                                 | Role                                             |
| ---------------------------------------------------- | ------------------------------------------------ |
| `server/src/providers/hook/sse/sse.ts`               | `HookProvider` implementation (`sseProvider`)    |
| `server/src/providers/hook/sse/types.ts`             | Upstream wire types                              |
| `server/src/providers/hook/sse/constants.ts`         | Event names, backoff/idle tuning                 |
| `server/src/providers/hook/sse/normalizeSseEvent.ts` | Upstream event → canonical `AgentEvent`          |
| `server/src/providers/hook/sse/sseClient.ts`         | SSE parser + reconnecting fetch client           |
| `server/src/providers/hook/sse/sseBridge.ts`         | Event pump (validation, adoption, tool tracking) |
| `server/src/cli.ts`                                  | `--provider/--sse-url/--sse-token` wiring        |
| `scripts/mock-sse-server.mjs`                        | Mock upstream for manual testing                 |
| `scripts/mi-cli-ia-sse-adapter.mjs`                  | Example dialect-translating proxy (mi-cli-ia)    |

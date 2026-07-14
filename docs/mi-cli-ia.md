# mi-cli-ia → Pixel Agents — usage runbook

How to watch your mi-cli-ia hub (tasks, roles, agent panels) as a pixel-art
office. The hub's SSE dialect (`task.*` / `message.*` / `turn.*`, camelCase
ids) is not what the Pixel Agents SSE provider expects (`agent.*`, snake_case
ids), so a small translating proxy sits in between — zero changes on either
side:

```text
mi-cli-ia hub ─SSE:7088─▶ mi-cli-ia-sse-adapter ─SSE:7089─▶ pixel-agents ─▶ http://localhost:3100
```

## Quick start (three terminals)

```bash
# 1. Your mi-cli-ia hub, emitting SSE events (default: port 7088)

# 2. The dialect adapter
node scripts/mi-cli-ia-sse-adapter.mjs \
  --upstream http://127.0.0.1:7088/events --upstream-token <hub-token>

# 3. Pixel Agents pointed at the adapter
node dist/cli.js --provider sse --sse-url http://127.0.0.1:7089/events
# or: npx pixel-agents --port 3100 --sse-url http://127.0.0.1:7089/events
```

Then open `http://localhost:3100`.

## What you'll see

- **One persistent character per agent panel** (`agentId`, e.g.
  `agent-battery-reader-panel` → "battery-reader"). Characters idle between
  tasks instead of despawning; `agent.slept` shows them as sleeping.
- **A synthetic "Hub" character** for orchestrator-level events (task
  lifecycle, schedules, human decisions). Disable it with `--no-hub`.
- **Activity labels** from streamed `turn.token` chunks (throttled to ~1/s,
  code fences skipped), handoff texts while thinking, and a red permission
  bubble on `task.human_decision`.

## Event mapping

| mi-cli-ia (upstream)                                                   | Pixel Agents (downstream)                      |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| `task.created` / `task.state_changed`                                  | Hub `agent.status.changed` (working/completed) |
| `schedule.fired`                                                       | Hub `agent.status.changed` (working)           |
| `task.human_decision`                                                  | `agent.permission.requested` (agent or Hub)    |
| `task.role_changed`                                                    | `agent.status.changed` (thinking)              |
| `task.role_completed`                                                  | `agent.session.completed` (via role→agent map) |
| `message.sent` (hub → agent)                                           | `agent.status.changed` (thinking, handoff)     |
| `turn.token`                                                           | `agent.status.changed` (editing, throttled)    |
| `message.received` (`kind: result` / `error`)                          | `agent.session.completed` (success/failed)     |
| `envelope.repair` / `envelope.mcp_final_answer` / `devin.autoContinue` | `agent.message`                                |
| `agent.slept`                                                          | `agent.status.changed` (idle)                  |

The agent's `project` is taken from `meta._acp_cwd` on handoff, so seats
group by workspace like any other provider.

## Adapter flags

| Flag                     | Default                        | Meaning                                 |
| ------------------------ | ------------------------------ | --------------------------------------- |
| `--upstream <url>`       | `http://127.0.0.1:7088/events` | mi-cli-ia SSE endpoint                  |
| `--upstream-token <tok>` | none                           | Bearer token for the hub                |
| `--port <n>`             | `7089`                         | Port the translated stream is served on |
| `--token <tok>`          | none                           | Require this bearer from downstream     |
| `--no-hub`               | hub on                         | Don't synthesize the Hub character      |

## Debugging

- `curl http://127.0.0.1:7089/healthz` — upstream connection state, connected
  downstream clients, and the adopted agent ids.
- The adapter logs every translated frame (`-> agent.status.changed <id>`)
  and both sides reconnect on their own: upstream with backoff +
  `Last-Event-ID` replay, downstream served from a replay ring buffer with a
  session snapshot for fresh clients — restarting any of the three processes
  is safe.

## Troubleshooting

- **`SSE: dropping "task.created" events without agent_id/session_id`** in
  the Pixel Agents log: you pointed `--sse-url` straight at the hub. Point it
  at the adapter's `/events` instead.
- **No characters appear**: check `/healthz` — if `upstream.state` is
  `reconnecting`, the hub URL/token is wrong; if it's `connected` but
  `agents` is empty, the hub simply hasn't emitted events yet (characters
  are adopted lazily on their first event).

See [sse-provider.md](sse-provider.md) for the downstream contract and the
generic patterns the adapter demonstrates.

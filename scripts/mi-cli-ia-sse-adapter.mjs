#!/usr/bin/env node
/**
 * mi-cli-ia -> Pixel Agents SSE adapter.
 *
 * Standalone bridge that consumes the mi-cli-ia hub event stream (task.* /
 * message.* / turn.* dialect, camelCase `taskId`/`agentId`) and re-serves it as
 * the `agent.*` SSE dialect the Pixel Agents SSE provider understands
 * (snake_case `agent_id`/`session_id`). Zero changes on either side.
 *
 *   mi-cli-ia hub ──SSE──> this adapter ──SSE──> pixel-agents --provider sse
 *
 * Usage:
 *   node scripts/mi-cli-ia-sse-adapter.mjs \
 *     [--upstream http://127.0.0.1:7088/events] [--upstream-token <token>] \
 *     [--port 7089] [--token <downstream-token>] [--no-hub]
 *
 *   node dist/cli.js --provider sse --sse-url http://127.0.0.1:7089/events
 *
 * Character model:
 * - Each mi-cli-ia agent panel (`agentId`) becomes one persistent character
 *   (session_id = agentId), idling between tasks instead of despawning.
 * - Task-level events (agentId: null) animate a synthetic "Hub" character:
 *   task lifecycle, schedules and human decisions. Disable with --no-hub.
 *
 * Event mapping (upstream -> downstream):
 *   task.created / task.state_changed  -> hub agent.status.changed (working/completed)
 *   schedule.fired                     -> hub agent.status.changed (working)
 *   task.human_decision                -> agent.permission.requested (agent or hub)
 *   task.role_changed                  -> agent.status.changed (thinking)
 *   task.role_completed                -> agent.session.completed (via role->agent map)
 *   message.sent (hub -> agent)        -> agent.status.changed (thinking, handoff text)
 *   turn.token                         -> agent.status.changed (editing, throttled)
 *   message.received (result/error)    -> agent.session.completed
 *   envelope.repair / envelope.mcp_final_answer / devin.autoContinue -> agent.message
 *   agent.slept                        -> agent.status.changed (idle)
 *
 * Transport: reconnects to the upstream with exponential backoff and
 * Last-Event-ID replay; serves /events with heartbeats, a replay ring buffer
 * and a session snapshot for fresh clients, plus /healthz for debugging.
 */

import * as http from 'node:http';

// ── Constants ─────────────────────────────────────────────────

const HUB_AGENT_ID = 'mi-cli-ia-hub';
const HUB_NAME = 'Hub';
const MESSAGE_MAX_LENGTH = 160;
const TOKEN_THROTTLE_MS = 900;
const RING_BUFFER_SIZE = 500;
const HEARTBEAT_MS = 20_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const IDLE_TIMEOUT_MS = 90_000;
const TERMINAL_TASK_STATES = new Set(['DONE', 'FAILED', 'CANCELLED', 'CANCELED']);
const NON_AGENT_IDS = new Set(['hub', 'human', '']);

// ── Small helpers ─────────────────────────────────────────────

function truncate(text, max = MESSAGE_MAX_LENGTH) {
  return text.length > max ? text.slice(0, max) + '\u2026' : text;
}

/** "agent-battery-reader-panel" -> "battery-reader" (cosmetic only). */
export function cleanAgentName(agentId) {
  return agentId.replace(/^agent-/, '').replace(/-panel$/, '') || agentId;
}

/** First non-empty, non-code-fence line of a streamed chunk, whitespace-collapsed. */
export function chunkLabel(chunk) {
  for (const line of String(chunk).split('\n')) {
    const cleaned = line.replace(/\s+/g, ' ').trim();
    if (cleaned && !cleaned.startsWith('```')) return truncate(cleaned);
  }
  return '';
}

function str(value) {
  return typeof value === 'string' && value ? value : undefined;
}

// ── Translator: mi-cli-ia dialect -> pixel-agents SSE dialect ─
//
// Stateful pure core (no I/O): feed it (eventName, dataString) pairs, get back
// an ordered list of { event, payload } frames in the downstream dialect.
// Exported so it can be unit-tested without sockets.

export function createTranslator({
  hubCharacter = true,
  now = Date.now,
  warn = console.warn,
} = {}) {
  /** agentId -> { name } once agent.session.started has been emitted. */
  const seenAgents = new Map();
  /** taskId -> title (from task.created), for hub status labels. */
  const taskTitles = new Map();
  /** Tasks currently not in a terminal state. */
  const activeTasks = new Set();
  /** `${taskId}\u0000${role}` -> agentId (from task.role_changed / message.sent). */
  const roleAgents = new Map();
  /** agentId -> last turn.token emit timestamp (throttle). */
  const lastTokenEmit = new Map();
  const warnedEvents = new Set();

  const warnOnce = (bucket, message) => {
    if (warnedEvents.has(bucket)) return;
    warnedEvents.add(bucket);
    warn(`[sse-adapter] ${message}`);
  };

  /** Wrap a downstream payload with the routing identity pixel-agents expects. */
  const frame = (event, agentId, payload) => ({
    event,
    payload: { agent_id: agentId, session_id: agentId, ...payload },
  });

  /** Emit agent.session.started once per character (charge project/role if known). */
  const ensureAgent = (frames, agentId, { role, project, timestamp } = {}) => {
    if (seenAgents.has(agentId)) return;
    const isHub = agentId === HUB_AGENT_ID;
    const name = isHub ? HUB_NAME : cleanAgentName(agentId);
    seenAgents.set(agentId, { name });
    frames.push(
      frame('agent.session.started', agentId, {
        name,
        role: role ?? (isHub ? 'orchestrator' : undefined),
        project: project ?? `mi-cli-ia:${agentId}`,
        timestamp,
      }),
    );
  };

  /** Snapshot of known characters, for adopting a fresh downstream client. */
  const sessionSnapshot = () =>
    [...seenAgents.entries()].map(([agentId, { name }]) =>
      frame('agent.session.started', agentId, { name, project: `mi-cli-ia:${agentId}` }),
    );

  const targetAgentId = (envelope, payload) =>
    str(envelope.agentId) ?? str(payload.agentId) ?? null;

  const taskLabel = (taskId, payload) =>
    str(payload.title) ?? taskTitles.get(taskId) ?? taskId ?? 'task';

  const translate = (eventName, dataString) => {
    let envelope;
    try {
      envelope = JSON.parse(dataString);
      if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
        throw new Error('not an object');
      }
    } catch {
      warnOnce(`json:${eventName}`, `dropping "${eventName}" events with malformed JSON`);
      return [];
    }

    const payload =
      typeof envelope.payload === 'object' && envelope.payload !== null ? envelope.payload : {};
    const taskId = str(envelope.taskId);
    const timestamp = str(envelope.ts);
    const agentId = targetAgentId(envelope, payload);
    const frames = [];

    /** Status change for a specific agent character (adopting it first). */
    const agentStatus = (id, status, message, extra = {}) => {
      ensureAgent(frames, id, { timestamp, ...extra });
      frames.push(frame('agent.status.changed', id, { status, message, timestamp }));
    };

    /** Status change for the hub character (no-op when --no-hub). */
    const hubStatus = (status, message) => {
      if (!hubCharacter) return;
      agentStatus(HUB_AGENT_ID, status, message);
    };

    switch (eventName) {
      case 'task.created': {
        const title = taskLabel(taskId, payload);
        if (taskId) {
          taskTitles.set(taskId, title);
          activeTasks.add(taskId);
        }
        const flow = str(payload.flow);
        hubStatus('working', truncate(`Task "${title}" created${flow ? ` (${flow})` : ''}`));
        break;
      }

      case 'task.state_changed': {
        const to = str(payload.to) ?? '?';
        const title = taskLabel(taskId, payload);
        if (TERMINAL_TASK_STATES.has(to)) {
          if (taskId) activeTasks.delete(taskId);
          if (activeTasks.size === 0) {
            hubStatus(
              to === 'DONE' ? 'completed' : 'failed',
              truncate(`Task "${title}" ${to.toLowerCase()}`),
            );
          } else {
            hubStatus(
              'working',
              truncate(`Task "${title}" ${to.toLowerCase()} (${activeTasks.size} running)`),
            );
          }
        } else {
          if (taskId) activeTasks.add(taskId);
          hubStatus('working', truncate(`Task "${title}": ${to.toLowerCase().replace(/_/g, ' ')}`));
        }
        break;
      }

      case 'schedule.fired': {
        const name = str(payload.schedule_id) ?? str(payload.id) ?? str(payload.name) ?? '';
        hubStatus('working', truncate(`Schedule fired${name ? `: ${name}` : ''}`));
        break;
      }

      case 'task.human_decision': {
        const question =
          str(payload.question) ??
          str(payload.prompt) ??
          str(payload.message) ??
          'Waiting for human decision';
        const target = agentId ?? (hubCharacter ? HUB_AGENT_ID : null);
        if (!target) break;
        ensureAgent(frames, target, { timestamp });
        frames.push(
          frame('agent.permission.requested', target, { message: truncate(question), timestamp }),
        );
        break;
      }

      case 'task.role_changed': {
        const role = str(payload.to);
        if (agentId && role && taskId) roleAgents.set(`${taskId}\u0000${role}`, agentId);
        if (agentId) agentStatus(agentId, 'thinking', truncate(`Role: ${role ?? '?'}`), { role });
        break;
      }

      case 'task.role_completed': {
        const role = str(payload.role);
        const owner = role && taskId ? roleAgents.get(`${taskId}\u0000${role}`) : undefined;
        if (!owner) break;
        const outcome = str(payload.outcome);
        ensureAgent(frames, owner, { timestamp });
        frames.push(
          frame('agent.session.completed', owner, {
            result: outcome === 'error' ? 'failed' : 'success',
            message: truncate(`${role} completed${outcome ? ` (${outcome})` : ''}`),
            timestamp,
          }),
        );
        break;
      }

      case 'message.sent': {
        const to = typeof payload.to === 'object' && payload.to !== null ? payload.to : {};
        const recipient = str(to.agentId) ?? agentId;
        if (!recipient || NON_AGENT_IDS.has(recipient)) break;
        const role = str(to.role);
        if (role && taskId) roleAgents.set(`${taskId}\u0000${role}`, recipient);
        const meta = typeof payload.meta === 'object' && payload.meta !== null ? payload.meta : {};
        const project = str(meta._acp_cwd);
        const content = str(payload.content) ?? 'Handoff received';
        agentStatus(recipient, 'thinking', truncate(content), { role, project });
        break;
      }

      case 'turn.token': {
        if (!agentId) break;
        const last = lastTokenEmit.get(agentId) ?? 0;
        const timeNow = now();
        if (timeNow - last < TOKEN_THROTTLE_MS) break;
        lastTokenEmit.set(agentId, timeNow);
        const role = str(payload.role);
        const label =
          chunkLabel(payload.chunk ?? '') || `Writing${role ? ` as ${role}` : ''}\u2026`;
        agentStatus(agentId, 'editing', label, { role });
        break;
      }

      case 'message.received': {
        const from = typeof payload.from === 'object' && payload.from !== null ? payload.from : {};
        const sender = str(from.agentId) ?? agentId;
        if (!sender || NON_AGENT_IDS.has(sender)) break;
        const content = str(payload.content) ?? '';
        const kind = str(payload.kind);
        ensureAgent(frames, sender, { role: str(from.role), timestamp });
        if (kind === 'result' || kind === 'error') {
          frames.push(
            frame('agent.session.completed', sender, {
              result: kind === 'error' ? 'failed' : 'success',
              message: truncate(content),
              timestamp,
            }),
          );
        } else {
          frames.push(frame('agent.message', sender, { message: truncate(content), timestamp }));
        }
        break;
      }

      case 'envelope.repair': {
        const target = agentId ?? (hubCharacter ? HUB_AGENT_ID : null);
        if (!target) break;
        const issues = str(payload.issues) ?? '';
        ensureAgent(frames, target, { timestamp });
        frames.push(
          frame('agent.message', target, {
            message: truncate(`Envelope repair${issues ? `: ${issues}` : ''}`),
            timestamp,
          }),
        );
        break;
      }

      case 'envelope.mcp_final_answer': {
        const target = agentId ?? (hubCharacter ? HUB_AGENT_ID : null);
        if (!target) break;
        const kind = str(payload.kind);
        ensureAgent(frames, target, { timestamp });
        frames.push(
          frame('agent.message', target, {
            message: truncate(`Final answer${kind ? ` (${kind})` : ''}`),
            timestamp,
          }),
        );
        break;
      }

      case 'devin.autoContinue': {
        const target = agentId ?? (hubCharacter ? HUB_AGENT_ID : null);
        if (!target) break;
        ensureAgent(frames, target, { timestamp });
        frames.push(frame('agent.message', target, { message: 'Auto-continue', timestamp }));
        break;
      }

      case 'agent.slept': {
        if (!agentId) break;
        agentStatus(agentId, 'idle', 'Sleeping');
        break;
      }

      default:
        warnOnce(`event:${eventName}`, `ignoring unknown upstream event "${eventName}"`);
        break;
    }

    return frames;
  };

  return { translate, sessionSnapshot };
}

// ── Upstream SSE client (fetch streaming, backoff, Last-Event-ID) ──

export function createSseParser(onEvent) {
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let eventId;

  const processLine = (line) => {
    if (line === '') {
      if (dataLines.length > 0) {
        onEvent({ event: eventName || 'message', data: dataLines.join('\n'), id: eventId });
        dataLines = [];
      }
      eventName = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id' && !value.includes('\u0000')) eventId = value;
  };

  return (chunk) => {
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      processLine(line);
    }
  };
}

function startUpstreamClient({ url, token, onEvent, onStateChange }) {
  let stopped = false;
  let abort = null;
  let lastEventId;
  let backoffMs = INITIAL_BACKOFF_MS;
  let idleTimer = null;

  const clearIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdleTimer = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      console.warn('[sse-adapter] upstream idle, forcing reconnect');
      abort?.abort();
    }, IDLE_TIMEOUT_MS);
  };

  const connectOnce = async () => {
    abort = new AbortController();
    const headers = { accept: 'text/event-stream', 'cache-control': 'no-cache' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (lastEventId !== undefined) headers['last-event-id'] = lastEventId;

    const response = await fetch(url, { headers, signal: abort.signal });
    if (!response.ok || !response.body) {
      throw new Error(`upstream responded ${response.status} ${response.statusText}`);
    }
    console.log(`[sse-adapter] connected to upstream ${url}`);
    onStateChange?.('connected');

    const parse = createSseParser((event) => {
      backoffMs = INITIAL_BACKOFF_MS;
      if (event.id !== undefined) lastEventId = event.id;
      try {
        onEvent(event);
      } catch (err) {
        console.error(`[sse-adapter] event handler error: ${err.message}`);
      }
    });

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        armIdleTimer();
        const { done, value } = await reader.read();
        if (done) break;
        if (value) parse(decoder.decode(value, { stream: true }));
      }
    } finally {
      clearIdleTimer();
      reader.releaseLock();
    }
    if (!stopped) console.log('[sse-adapter] upstream stream closed');
  };

  void (async () => {
    while (!stopped) {
      try {
        await connectOnce();
      } catch (err) {
        if (!stopped) console.error(`[sse-adapter] upstream error: ${err.message}`);
      }
      onStateChange?.('reconnecting');
      if (stopped) return;
      console.log(`[sse-adapter] reconnecting to upstream in ${Math.round(backoffMs / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  })();

  return {
    stop: () => {
      stopped = true;
      clearIdleTimer();
      abort?.abort();
    },
  };
}

// ── Main: wire upstream -> translator -> downstream SSE server ──

function parseArgs(argv) {
  const args = {
    upstream: 'http://127.0.0.1:7088/events',
    upstreamToken: null,
    port: 7089,
    token: null,
    hub: true,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--upstream' && argv[i + 1]) args.upstream = argv[++i];
    else if (argv[i] === '--upstream-token' && argv[i + 1]) args.upstreamToken = argv[++i];
    else if (argv[i] === '--port' && argv[i + 1]) args.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--token' && argv[i + 1]) args.token = argv[++i];
    else if (argv[i] === '--no-hub') args.hub = false;
    else if (argv[i] === '--help') {
      console.log(`Usage: node scripts/mi-cli-ia-sse-adapter.mjs [options]

Options:
  --upstream <url>         mi-cli-ia SSE endpoint (default: http://127.0.0.1:7088/events)
  --upstream-token <tok>   Bearer token for the upstream endpoint
  --port <number>          Port to serve the translated stream on (default: 7089)
  --token <tok>            Require this bearer token from downstream clients
  --no-hub                 Do not synthesize the "Hub" orchestrator character
  --help                   Show this help message

Then point Pixel Agents at the adapter:
  node dist/cli.js --provider sse --sse-url http://127.0.0.1:<port>/events`);
      process.exit(0);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const translator = createTranslator({ hubCharacter: args.hub });

  let nextEventId = 1;
  let upstreamState = 'connecting';
  const clients = new Set();
  /** Replay ring buffer of the last frames: { id, text }. */
  const ring = [];

  const frameText = (id, { event, payload }) =>
    `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

  const broadcast = (frames) => {
    for (const f of frames) {
      const id = nextEventId++;
      const text = frameText(id, f);
      ring.push({ id, text });
      if (ring.length > RING_BUFFER_SIZE) ring.shift();
      for (const res of clients) res.write(text);
      console.log(`[sse-adapter] -> ${f.event} ${f.payload.agent_id}`);
    }
  };

  const upstream = startUpstreamClient({
    url: args.upstream,
    token: args.upstreamToken ?? undefined,
    onEvent: (event) => broadcast(translator.translate(event.event, event.data)),
    onStateChange: (state) => {
      upstreamState = state;
    },
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          upstream: { url: args.upstream, state: upstreamState },
          clients: clients.size,
          agents: translator.sessionSnapshot().map((f) => f.payload.agent_id),
        }),
      );
      return;
    }

    if (url.pathname !== '/events') {
      res.writeHead(404).end('not found');
      return;
    }
    if (args.token && req.headers.authorization !== `Bearer ${args.token}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    // Reconnecting client with a known Last-Event-ID: replay the missed tail.
    // Fresh client (or overflowed buffer): adopt the known cast via a snapshot.
    const lastId = parseInt(String(req.headers['last-event-id'] ?? ''), 10);
    const tailStart = ring.findIndex((entry) => entry.id > lastId);
    if (!Number.isNaN(lastId) && tailStart !== -1 && ring.some((entry) => entry.id === lastId)) {
      for (let i = tailStart; i < ring.length; i++) res.write(ring[i].text);
    } else {
      for (const f of translator.sessionSnapshot()) res.write(frameText(nextEventId++, f));
    }

    clients.add(res);
    console.log(`[sse-adapter] downstream client connected (${clients.size} total)`);
    req.on('close', () => {
      clients.delete(res);
      console.log(`[sse-adapter] downstream client disconnected (${clients.size} left)`);
    });
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(':hb\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  server.listen(args.port, '127.0.0.1', () => {
    console.log(
      `[sse-adapter] translating ${args.upstream} -> http://127.0.0.1:${args.port}/events`,
    );
    console.log(
      `[sse-adapter] try: node dist/cli.js --provider sse --sse-url http://127.0.0.1:${args.port}/events${args.token ? ` --sse-token ${args.token}` : ''}`,
    );
  });

  const shutdown = () => {
    upstream.stop();
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

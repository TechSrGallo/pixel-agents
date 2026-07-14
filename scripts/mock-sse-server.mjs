#!/usr/bin/env node
/**
 * Mock upstream agent system for manually testing the SSE provider.
 *
 * Serves GET /events as text/event-stream and plays a looping scenario with
 * three agents (sessions start, tools run, a permission request, messages,
 * completion). Supports Last-Event-ID replay and bearer-token auth checks.
 *
 * Usage:
 *   node scripts/mock-sse-server.mjs [--port 8090] [--token secret]
 *
 * Then point Pixel Agents at it:
 *   node dist/cli.js --provider sse --sse-url http://127.0.0.1:8090/events
 */

import * as http from 'node:http';

const args = process.argv.slice(2);
let port = 8090;
let token = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
  else if (args[i] === '--token' && args[i + 1]) token = args[++i];
}

/** Scenario steps: [delay-ms-before, event-name, payload]. Loops forever. */
const agents = [
  { agent_id: 'agent-backend', name: 'Backend Engineer', role: 'coder' },
  { agent_id: 'agent-frontend', name: 'Frontend Engineer', role: 'coder' },
  { agent_id: 'agent-reviewer', name: 'Code Reviewer', role: 'reviewer' },
];

function buildScenario(run) {
  const steps = [];
  const s = (delay, event, payload) => steps.push([delay, event, payload]);
  const ids = agents.map((a) => ({
    ...a,
    session_id: `session-${run}-${a.agent_id}`,
    project: `/workspace/demo/${a.agent_id.replace('agent-', '')}`,
  }));
  const [backend, frontend, reviewer] = ids;

  for (const a of ids) {
    s(600, 'agent.session.started', {
      agent_id: a.agent_id,
      session_id: a.session_id,
      name: a.name,
      role: a.role,
      project: a.project,
      model: 'demo-model',
    });
  }
  s(
    1200,
    'agent.status.changed',
    ev(backend, { status: 'thinking', activity: 'Planning the fix' }),
  );
  s(800, 'agent.status.changed', ev(frontend, { status: 'reading', activity: 'Reading App.tsx' }));
  s(800, 'agent.tool.started', ev(reviewer, { tool: 'shell', command: 'git diff main...HEAD' }));
  s(
    1500,
    'agent.status.changed',
    ev(backend, { status: 'editing', activity: 'Updating validation logic' }),
  );
  s(1200, 'agent.tool.completed', ev(reviewer, { tool: 'shell', success: true, exit_code: 0 }));
  s(600, 'agent.tool.started', ev(backend, { tool: 'shell', command: 'npm test' }));
  s(
    1000,
    'agent.message',
    ev(frontend, { message: 'The header component needs a design decision' }),
  );
  s(
    1500,
    'agent.permission.requested',
    ev(frontend, { permission_id: 'perm-1', message: 'Wants to modify package.json' }),
  );
  s(
    2500,
    'agent.tool.completed',
    ev(backend, { tool: 'shell', success: true, exit_code: 0, message: 'Tests passed' }),
  );
  s(
    800,
    'agent.status.changed',
    ev(frontend, { status: 'working', activity: 'Applying approved change' }),
  );
  s(
    1000,
    'agent.status.changed',
    ev(reviewer, { status: 'waiting_input', message: 'Review done, awaiting reply' }),
  );
  s(
    1500,
    'agent.session.completed',
    ev(backend, { result: 'success', message: 'Implementation completed' }),
  );
  s(1200, 'agent.session.completed', ev(frontend, { result: 'success' }));
  s(1500, 'agent.session.ended', ev(reviewer, { result: 'success' }));
  s(2000, 'agent.session.ended', ev(backend, { result: 'success' }));
  s(500, 'agent.session.ended', ev(frontend, { result: 'success' }));
  return steps;

  function ev(a, extra) {
    return { agent_id: a.agent_id, session_id: a.session_id, ...extra };
  }
}

let nextEventId = 1;
const clients = new Set();

const server = http.createServer((req, res) => {
  if (!req.url?.startsWith('/events')) {
    res.writeHead(404).end('not found');
    return;
  }
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  clients.add(res);
  const lastId = req.headers['last-event-id'];
  console.log(
    `[mock-sse] client connected${lastId ? ` (Last-Event-ID: ${lastId})` : ''} (${clients.size} total)`,
  );
  req.on('close', () => {
    clients.delete(res);
    console.log(`[mock-sse] client disconnected (${clients.size} left)`);
  });
});

function broadcast(event, payload) {
  const frame = `id: ${nextEventId++}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(frame);
  console.log(`[mock-sse] ${event} ${payload.agent_id ?? ''}`);
}

async function playForever() {
  for (let run = 1; ; run++) {
    console.log(`[mock-sse] scenario run ${run} starting`);
    for (const [delay, event, payload] of buildScenario(run)) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      broadcast(event, payload);
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
}

const heartbeat = setInterval(() => {
  for (const res of clients) res.write(': heartbeat\n\n');
}, 15000);
heartbeat.unref();

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-sse] streaming scenario at http://127.0.0.1:${port}/events`);
  if (token) console.log('[mock-sse] bearer token required');
  console.log(
    `[mock-sse] try: node dist/cli.js --provider sse --sse-url http://127.0.0.1:${port}/events${token ? ` --sse-token ${token}` : ''}`,
  );
  void playForever();
});

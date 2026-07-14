import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Controllable SSE upstream for standalone `--provider sse` tests.
 *
 * Unlike scripts/mock-sse-server.mjs (which streams a fixed timed scenario),
 * this server emits nothing on its own: tests push events explicitly via
 * `sendEvent`, so every assertion has a deterministic trigger.
 */
export interface SseUpstream {
  /** URL of the /events endpoint to pass to the CLI via --sse-url. */
  url: string;
  /** Resolves once the CLI's SSE client is connected to /events. */
  waitForConnection: (timeoutMs?: number) => Promise<void>;
  /** Broadcast a named SSE event with a JSON payload to connected clients. */
  sendEvent: (event: string, payload: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

export async function startSseUpstream(): Promise<SseUpstream> {
  const clients = new Set<http.ServerResponse>();

  const server = http.createServer((request, response) => {
    if (!request.url?.startsWith('/events')) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/events`,
    waitForConnection: async (timeoutMs = 15_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (clients.size === 0) {
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for the CLI SSE client to connect');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    sendEvent: (event, payload): void => {
      const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const client of clients) {
        client.write(frame);
      }
    },
    close: async (): Promise<void> => {
      for (const client of clients) {
        client.destroy();
      }
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

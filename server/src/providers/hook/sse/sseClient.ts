import { SSE_IDLE_TIMEOUT_MS, SSE_INITIAL_BACKOFF_MS, SSE_MAX_BACKOFF_MS } from './constants.js';

/** One parsed SSE event (after a blank-line dispatch). */
export interface ParsedSseEvent {
  /** `event:` field; defaults to 'message' per the SSE spec. */
  event: string;
  /** Concatenated `data:` lines, joined with '\n'. */
  data: string;
  /** `id:` field, if the upstream sent one. */
  id?: string;
}

/**
 * Incremental text/event-stream parser. Feed it raw chunks; it invokes the
 * callback once per complete event (blank-line delimited). Handles CRLF, multi-line
 * data, comments (`:` heartbeats) and the `retry:` field. Pure and network-free so
 * it can be unit-tested directly.
 */
export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];
  private eventId: string | undefined;

  constructor(
    private readonly onEvent: (event: ParsedSseEvent) => void,
    private readonly onRetry?: (retryMs: number) => void,
  ) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment / keepalive

    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        // Per spec, ids containing NUL are ignored.
        if (!value.includes('\u0000')) this.eventId = value;
        break;
      case 'retry': {
        const ms = parseInt(value, 10);
        if (!Number.isNaN(ms) && ms >= 0) this.onRetry?.(ms);
        break;
      }
      default:
        break; // unknown field: ignore per spec
    }
  }

  private dispatch(): void {
    if (this.dataLines.length === 0) {
      // Event with no data: reset name but dispatch nothing (spec behavior).
      this.eventName = '';
      return;
    }
    this.onEvent({
      event: this.eventName || 'message',
      data: this.dataLines.join('\n'),
      id: this.eventId,
    });
    this.eventName = '';
    this.dataLines = [];
  }
}

/** Options for SseStreamClient. */
export interface SseClientOptions {
  /** Upstream SSE endpoint URL. */
  url: string;
  /** Optional bearer token (Authorization: Bearer <token>). */
  token?: string;
  /** Called once per upstream event. */
  onEvent: (event: ParsedSseEvent) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Reconnect when the stream is silent this long. 0 disables the idle check. */
  idleTimeoutMs?: number;
}

/**
 * Minimal SSE client on native fetch streaming (no runtime dependencies).
 *
 * Lifecycle: start() opens the connect loop; stop() aborts and stays stopped.
 * Reconnects with exponential backoff (reset after a successful event), resends
 * `Last-Event-ID` when the upstream provided ids, honors the `retry:` field, and
 * aborts silent connections after idleTimeoutMs. Never throws into the caller;
 * malformed payloads are the bridge's problem (this layer only frames events).
 */
export class SseStreamClient {
  private stopped = true;
  private abort: AbortController | null = null;
  private lastEventId: string | undefined;
  private backoffMs: number;
  private retryOverrideMs: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly options: SseClientOptions) {
    this.backoffMs = options.initialBackoffMs ?? SSE_INITIAL_BACKOFF_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.clearIdleTimer();
    this.abort?.abort();
    this.abort = null;
  }

  /** Resolves when the connect loop has fully exited (after stop()). */
  async join(): Promise<void> {
    await this.loopPromise;
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
      } catch (err) {
        if (!this.stopped) {
          console.error(`[Pixel Agents] SSE: connection error: ${(err as Error).message}`);
        }
      }
      if (this.stopped) return;
      const delay = this.retryOverrideMs ?? this.backoffMs;
      console.log(`[Pixel Agents] SSE: reconnecting in ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
      this.backoffMs = Math.min(
        this.backoffMs * 2,
        this.options.maxBackoffMs ?? SSE_MAX_BACKOFF_MS,
      );
    }
  }

  private async connectOnce(): Promise<void> {
    this.abort = new AbortController();
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
    };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    if (this.lastEventId !== undefined) headers['last-event-id'] = this.lastEventId;

    const response = await fetch(this.options.url, {
      headers,
      signal: this.abort.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`upstream responded ${response.status} ${response.statusText}`);
    }
    console.log(`[Pixel Agents] SSE: connected to ${this.options.url}`);

    const parser = new SseParser(
      (event) => {
        // A delivered event proves the connection is healthy: reset backoff.
        this.backoffMs = this.options.initialBackoffMs ?? SSE_INITIAL_BACKOFF_MS;
        if (event.id !== undefined) this.lastEventId = event.id;
        try {
          this.options.onEvent(event);
        } catch (err) {
          // A bad handler must never kill the stream.
          console.error(`[Pixel Agents] SSE: event handler error: ${(err as Error).message}`);
        }
      },
      (retryMs) => {
        this.retryOverrideMs = retryMs;
      },
    );

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        this.armIdleTimer();
        const { done, value } = await reader.read();
        if (done) break;
        if (value) parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      this.clearIdleTimer();
      reader.releaseLock();
    }
    if (!this.stopped) {
      console.log('[Pixel Agents] SSE: stream closed by upstream');
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const timeout = this.options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
    if (timeout <= 0) return;
    this.idleTimer = setTimeout(() => {
      console.warn('[Pixel Agents] SSE: stream idle, forcing reconnect');
      this.abort?.abort();
    }, timeout);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

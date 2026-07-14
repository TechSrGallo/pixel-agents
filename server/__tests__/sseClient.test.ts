import { describe, expect, it, vi } from 'vitest';

import type { ParsedSseEvent } from '../src/providers/hook/sse/sseClient.js';
import { SseParser } from '../src/providers/hook/sse/sseClient.js';

function collect(): { events: ParsedSseEvent[]; retries: number[]; parser: SseParser } {
  const events: ParsedSseEvent[] = [];
  const retries: number[] = [];
  const parser = new SseParser(
    (event) => events.push(event),
    (ms) => retries.push(ms),
  );
  return { events, retries, parser };
}

describe('SseParser', () => {
  it('dispatches a named event with its data payload', () => {
    const { events, parser } = collect();
    parser.feed('event: agent.message\ndata: {"a":1}\n\n');
    expect(events).toEqual([{ event: 'agent.message', data: '{"a":1}', id: undefined }]);
  });

  it('defaults the event name to message per the SSE spec', () => {
    const { events, parser } = collect();
    parser.feed('data: hello\n\n');
    expect(events).toEqual([{ event: 'message', data: 'hello', id: undefined }]);
  });

  it('joins multi-line data with newlines', () => {
    const { events, parser } = collect();
    parser.feed('data: line1\ndata: line2\n\n');
    expect(events[0]?.data).toBe('line1\nline2');
  });

  it('handles events split across arbitrary chunk boundaries', () => {
    const { events, parser } = collect();
    parser.feed('eve');
    parser.feed('nt: foo\nda');
    parser.feed('ta: bar\n');
    expect(events).toHaveLength(0);
    parser.feed('\n');
    expect(events).toEqual([{ event: 'foo', data: 'bar', id: undefined }]);
  });

  it('strips CRLF line endings', () => {
    const { events, parser } = collect();
    parser.feed('event: foo\r\ndata: bar\r\n\r\n');
    expect(events).toEqual([{ event: 'foo', data: 'bar', id: undefined }]);
  });

  it('ignores comment lines and dataless events', () => {
    const { events, parser } = collect();
    parser.feed(': keepalive\n\n');
    parser.feed('event: ping\n\n');
    expect(events).toHaveLength(0);
  });

  it('tracks event ids and keeps the last one for subsequent events', () => {
    const { events, parser } = collect();
    parser.feed('id: 42\ndata: first\n\n');
    parser.feed('data: second\n\n');
    expect(events[0]?.id).toBe('42');
    expect(events[1]?.id).toBe('42');
  });

  it('ignores ids containing NUL characters', () => {
    const { events, parser } = collect();
    parser.feed('id: bad\u0000id\ndata: x\n\n');
    expect(events[0]?.id).toBeUndefined();
  });

  it('reports retry: overrides through the callback', () => {
    const { retries, parser } = collect();
    parser.feed('retry: 5000\n\n');
    parser.feed('retry: nonsense\n\n');
    expect(retries).toEqual([5000]);
  });

  it('never throws on malformed field lines', () => {
    const { events, parser } = collect();
    expect(() => parser.feed('garbage-without-colon\ndata: ok\n\n')).not.toThrow();
    expect(events).toEqual([{ event: 'message', data: 'ok', id: undefined }]);
  });

  it('does not invoke the handler for incomplete trailing events', () => {
    const onEvent = vi.fn();
    const parser = new SseParser(onEvent);
    parser.feed('event: foo\ndata: bar\n');
    expect(onEvent).not.toHaveBeenCalled();
  });
});

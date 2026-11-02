// The trace wire guard, the reducer and the EventSource store of the Task page (AIR-184).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import b01 from '../fixtures/trace-b01.json' with { type: 'json' };
import hostile from '../fixtures/trace-hostile.json' with { type: 'json' };
import u01 from '../fixtures/trace-u01.json' with { type: 'json' };
import { TRACE_KINDS, parseTraceEvent } from '../src/task/trace.ts';
import type { TraceEventWire } from '../src/task/trace.ts';
import { createTraceStore, initialTraceState, reduce } from '../src/task/traceStore.ts';
import type { TraceState } from '../src/task/traceStore.ts';

const branch = (n: number): TraceEventWire => ({ t: n, kind: 'branch', data: { step: [n], kind: 'if', taken: true, pc: ['Owner'] } });

function feed(events: TraceEventWire[], from = 0): TraceState {
  let s = initialTraceState();
  events.forEach((event, i) => {
    s = reduce(s, { type: 'event', id: from + i, event });
  });
  return s;
}

test('parseTraceEvent: null for non-JSON, an array, a scalar and null', () => {
  assert.equal(parseTraceEvent('not json'), null);
  assert.equal(parseTraceEvent('[]'), null);
  assert.equal(parseTraceEvent('3'), null);
  assert.equal(parseTraceEvent('null'), null);
  assert.equal(parseTraceEvent(''), null);
});

test('parseTraceEvent: null for an unknown kind, a missing or non-object data and a non-finite t', () => {
  assert.equal(parseTraceEvent('{"t":1,"kind":"say","data":{}}'), null);
  assert.equal(parseTraceEvent('{"t":1,"kind":"constructor","data":{}}'), null);
  assert.equal(parseTraceEvent('{"t":1,"kind":"call"}'), null);
  assert.equal(parseTraceEvent('{"t":1,"kind":"call","data":[]}'), null);
  assert.equal(parseTraceEvent('{"t":1,"kind":"call","data":null}'), null);
  assert.equal(parseTraceEvent('{"t":"1","kind":"call","data":{}}'), null);
  assert.equal(parseTraceEvent('{"t":1e999,"kind":"call","data":{}}'), null);
  assert.equal(parseTraceEvent('{"kind":"call","data":{}}'), null);
});

test('parseTraceEvent: every kind of the closed list parses', () => {
  assert.equal(TRACE_KINDS.length, 12);
  for (const kind of TRACE_KINDS) {
    const e = parseTraceEvent(JSON.stringify({ t: 5, kind, data: { a: 1 } }));
    assert.deepEqual(e, { t: 5, kind, data: { a: 1 } });
  }
});

test('parseTraceEvent: the three fixtures parse event by event', () => {
  for (const f of [u01, b01, hostile]) {
    assert.ok(f.events.length >= 7);
    for (const e of f.events) assert.notEqual(parseTraceEvent(JSON.stringify(e)), null);
  }
});

test('reduce: events in order give rows in order and lastId follows', () => {
  const s = feed([branch(1), branch(2), branch(3)]);
  assert.equal(s.rows.length, 3);
  assert.deepEqual(
    s.rows.map((r) => r.key),
    ['0', '1', '2'],
  );
  assert.equal(s.lastId, 2);
  assert.equal(s.collapsed, 0);
  assert.equal(s.ended, null);
});

test('reduce: the same id twice gives one row, and a lower id is ignored', () => {
  let s = feed([branch(1), branch(2)]);
  s = reduce(s, { type: 'event', id: 1, event: branch(9) });
  s = reduce(s, { type: 'event', id: 0, event: branch(9) });
  assert.equal(s.rows.length, 2);
  assert.equal(s.lastId, 1);
});

test('reduce: 301 events give 300 rows and collapsed 1, the oldest row is the one dropped', () => {
  const s = feed(Array.from({ length: 301 }, (_, i) => branch(i)));
  assert.equal(s.rows.length, 300);
  assert.equal(s.collapsed, 1);
  assert.equal(s.rows[0]?.key, '1');
  assert.equal(s.rows[299]?.key, '300');
  const more = reduce(s, { type: 'event', id: 301, event: branch(301) });
  assert.equal(more.rows.length, 300);
  assert.equal(more.collapsed, 2);
});

test('reduce: a drop sets stale and the next open clears it', () => {
  let s = feed([branch(1)]);
  s = reduce(s, { type: 'drop' });
  assert.equal(s.stale, true);
  s = reduce(s, { type: 'open' });
  assert.equal(s.stale, false);
  assert.equal(s.rows.length, 1);
});

test('reduce: end sets ended and later events, drops and malformed messages are ignored', () => {
  let s = feed([branch(1)]);
  s = reduce(s, { type: 'end', state: 'done' });
  assert.equal(s.ended, 'done');
  const after = reduce(reduce(reduce(s, { type: 'event', id: 5, event: branch(5) }), { type: 'drop' }), { type: 'malformed' });
  assert.deepEqual(after, s);
  assert.equal(after.stale, false);
});

test('reduce: a malformed message counts and adds no row', () => {
  const s = reduce(feed([branch(1)]), { type: 'malformed' });
  assert.equal(s.malformed, 1);
  assert.equal(s.rows.length, 1);
});

test('reduce: reset returns the first state', () => {
  const s = reduce(reduce(feed([branch(1)]), { type: 'drop' }), { type: 'reset' });
  assert.deepEqual(s, initialTraceState());
});

test('reduce is pure: the input state is not changed', () => {
  const s = feed([branch(1)]);
  const copy = JSON.stringify(s);
  reduce(s, { type: 'event', id: 1, event: branch(2) });
  reduce(s, { type: 'end', state: 'failed' });
  assert.equal(JSON.stringify(s), copy);
});

// a fake EventSource that records what the store does to it
class FakeSource {
  static all: FakeSource[] = [];
  readonly listeners = new Map<string, ((m: { data: string; lastEventId: string }) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, cb: (m: { data: string; lastEventId: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: string, lastEventId = ''): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data, lastEventId });
  }
}

const RUN = '0123456789abcdef0123456789abcdef';

function harness() {
  FakeSource.all = [];
  const frames: (() => void)[] = [];
  const store = createTraceStore({
    EventSource: FakeSource as unknown as typeof EventSource,
    raf: (cb) => frames.push(cb),
  });
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  const frame = (): void => {
    const f = frames.splice(0);
    for (const cb of f) cb();
  };
  return { store, frames, frame, notified: () => notified };
}

test('connect: no EventSource exists before connect', () => {
  const h = harness();
  assert.equal(FakeSource.all.length, 0);
  assert.equal(h.store.getSnapshot().rows.length, 0);
});

test('connect: one same-origin relative URL on the run id', () => {
  const h = harness();
  h.store.connect(RUN);
  assert.equal(FakeSource.all.length, 1);
  assert.equal(FakeSource.all[0]?.url, `/runs/${RUN}/events`);
});

test('connect: a bad run id throws and opens nothing', () => {
  const h = harness();
  for (const bad of ['', 'abc', RUN.toUpperCase(), `${RUN}0`, '../x', `${RUN.slice(0, 31)}g`]) assert.throws(() => h.store.connect(bad), /run id/i);
  assert.equal(FakeSource.all.length, 0);
});

test('connect: a second connect closes the first and starts from an empty list', () => {
  const h = harness();
  h.store.connect(RUN);
  FakeSource.all[0]?.emit('trace', JSON.stringify(branch(1)), '0');
  h.frame();
  assert.equal(h.store.getSnapshot().rows.length, 1);
  h.store.connect('f'.repeat(32));
  assert.equal(FakeSource.all[0]?.closed, true);
  assert.equal(FakeSource.all.length, 2);
  assert.equal(h.store.getSnapshot().rows.length, 0);
});

test('connect: messages are applied once per animation frame, not per message', () => {
  const h = harness();
  h.store.connect(RUN);
  const src = FakeSource.all[0] as FakeSource;
  const before = h.notified();
  for (let i = 0; i < 5; i++) src.emit('trace', JSON.stringify(branch(i)), String(i));
  assert.equal(h.frames.length, 1, 'one frame requested for five messages');
  assert.equal(h.store.getSnapshot().rows.length, 0, 'nothing applied before the frame');
  h.frame();
  assert.equal(h.store.getSnapshot().rows.length, 5);
  assert.equal(h.notified() - before, 1, 'one notification for the frame');
  src.emit('trace', JSON.stringify(branch(5)), '5');
  assert.equal(h.frames.length, 1, 'the next message asks for the next frame');
});

test('connect: a repeated Last-Event-ID position does not add a row', () => {
  const h = harness();
  h.store.connect(RUN);
  const src = FakeSource.all[0] as FakeSource;
  src.emit('trace', JSON.stringify(branch(1)), '0');
  src.emit('trace', JSON.stringify(branch(2)), '1');
  h.frame();
  src.emit('trace', JSON.stringify(branch(1)), '0');
  src.emit('trace', JSON.stringify(branch(2)), '1');
  src.emit('trace', JSON.stringify(branch(3)), '2');
  h.frame();
  assert.equal(h.store.getSnapshot().rows.length, 3);
});

test('connect: a message that is not a trace event, or has no usable id, counts as malformed', () => {
  const h = harness();
  h.store.connect(RUN);
  const src = FakeSource.all[0] as FakeSource;
  src.emit('trace', 'nope', '0');
  src.emit('trace', JSON.stringify(branch(1)), '');
  src.emit('trace', JSON.stringify(branch(1)), '-1');
  src.emit('trace', JSON.stringify({ t: 1, kind: 'nope', data: {} }), '3');
  h.frame();
  const s = h.store.getSnapshot();
  assert.equal(s.malformed, 4);
  assert.equal(s.rows.length, 0);
});

test('connect: end sets ended, closes the source at once and later messages change nothing', () => {
  const h = harness();
  h.store.connect(RUN);
  const src = FakeSource.all[0] as FakeSource;
  src.emit('trace', JSON.stringify(branch(1)), '0');
  src.emit('end', '{"state":"done"}');
  assert.equal(src.closed, true, 'closed in the handler, so the browser never reconnects');
  src.emit('trace', JSON.stringify(branch(2)), '1');
  h.frame();
  const s = h.store.getSnapshot();
  assert.equal(s.ended, 'done');
  assert.equal(s.rows.length, 1);
});

test('connect: an end state outside the three names reads as failed, a bad body as failed too', () => {
  for (const [body, want] of [
    ['{"state":"aborted"}', 'aborted'],
    ['{"state":"failed"}', 'failed'],
    ['{"state":"weird"}', 'failed'],
    ['garbage', 'failed'],
  ] as const) {
    const h = harness();
    h.store.connect(RUN);
    FakeSource.all[0]?.emit('end', body);
    h.frame();
    assert.equal(h.store.getSnapshot().ended, want, body);
  }
});

test('connect: an error sets stale, the next open clears it, and an error after end does not', () => {
  const h = harness();
  h.store.connect(RUN);
  const src = FakeSource.all[0] as FakeSource;
  src.onopen?.();
  h.frame();
  src.onerror?.();
  h.frame();
  assert.equal(h.store.getSnapshot().stale, true);
  src.onopen?.();
  h.frame();
  assert.equal(h.store.getSnapshot().stale, false);
  src.emit('end', '{"state":"done"}');
  src.onerror?.();
  h.frame();
  assert.equal(h.store.getSnapshot().stale, false);
});

test('connect: disconnect closes the source and drops what was queued', () => {
  const h = harness();
  h.store.connect(RUN);
  const src = FakeSource.all[0] as FakeSource;
  src.emit('trace', JSON.stringify(branch(1)), '0');
  h.store.disconnect();
  assert.equal(src.closed, true);
  h.frame();
  assert.equal(h.store.getSnapshot().rows.length, 0);
});

test('subscribe: the returned function stops notifications, and the snapshot is stable between changes', () => {
  const h = harness();
  const a = h.store.getSnapshot();
  assert.equal(h.store.getSnapshot(), a);
  let n = 0;
  const off = h.store.subscribe(() => {
    n += 1;
  });
  h.store.connect(RUN);
  FakeSource.all[0]?.emit('trace', JSON.stringify(branch(1)), '0');
  h.frame();
  assert.equal(n, 1);
  off();
  FakeSource.all[0]?.emit('trace', JSON.stringify(branch(2)), '1');
  h.frame();
  assert.equal(n, 1);
});

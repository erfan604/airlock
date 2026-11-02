// AIR-161: GET /runs/:id/events. Resumable by Last-Event-ID, ends with an explicit end event, cleans up after an abort.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceEvent } from '../src/interpreter/trace.ts';
import { createTestSession } from '../src/server/app.ts';
import type { RunEventSource } from '../src/server/app.ts';
import { FakeRuns, makeApp } from './helpers/server.ts';

const ev = (n: number): TraceEvent => ({ t: n, kind: 'call', data: { n } });

interface Message {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

function parse(text: string): Message[] {
  const out: Message[] = [];
  for (const block of text.split('\n\n')) {
    if (block.trim() === '') continue;
    const m: Message = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(': ')) m.comment = line.slice(2);
      else if (line.startsWith('id: ')) m.id = line.slice(4);
      else if (line.startsWith('event: ')) m.event = line.slice(7);
      else if (line.startsWith('data: ')) m.data = line.slice(6);
    }
    out.push(m);
  }
  return out;
}

async function setup(runs: RunEventSource) {
  const h = makeApp({ mode: 'replay', runEvents: runs });
  const cookie = await createTestSession(h.app);
  return { h, cookie };
}

/** reads until `until` returns true for the text so far or the stream closes */
async function readUntil(res: Response, until: (text: string) => boolean): Promise<{ text: string; closed: boolean; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text, closed: true, reader };
    text += decoder.decode(value, { stream: true });
    if (until(text)) return { text, closed: false, reader };
  }
}

test('a run of three events replays as id 0..2 with event trace, then event end when the run is done, and the stream closes', async () => {
  const runs = new FakeRuns();
  runs.add('r1', [ev(0), ev(1), ev(2)], 'done');
  const { h, cookie } = await setup(runs);
  const res = await h.app.request('/runs/r1/events', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
  const messages = parse(await res.text());
  assert.deepEqual(
    messages.map((m) => [m.id, m.event]),
    [['0', 'trace'], ['1', 'trace'], ['2', 'trace'], [undefined, 'end']],
  );
  assert.deepEqual(messages.slice(0, 3).map((m) => JSON.parse(m.data as string)), [ev(0), ev(1), ev(2)]);
  assert.equal(messages[3]?.data, '{"state":"done"}');
  assert.equal(runs.count('r1'), 0, 'unsubscribed after the end');
});

test('failed and aborted runs end the stream too, with their state', async () => {
  for (const state of ['failed', 'aborted']) {
    const runs = new FakeRuns();
    runs.add('r', [ev(0)], state);
    const { h, cookie } = await setup(runs);
    const messages = parse(await (await h.app.request('/runs/r/events', { headers: { cookie } })).text());
    assert.equal(messages.at(-1)?.event, 'end');
    assert.equal(messages.at(-1)?.data, `{"state":"${state}"}`);
  }
});

test('Last-Event-ID: 1 replays only the third event; a value past the end replays none', async () => {
  const runs = new FakeRuns();
  runs.add('r1', [ev(0), ev(1), ev(2)], 'done');
  const { h, cookie } = await setup(runs);
  const one = parse(await (await h.app.request('/runs/r1/events', { headers: { cookie, 'last-event-id': '1' } })).text());
  assert.deepEqual(one.map((m) => [m.id, m.event]), [['2', 'trace'], [undefined, 'end']]);
  const past = parse(await (await h.app.request('/runs/r1/events', { headers: { cookie, 'last-event-id': '9' } })).text());
  assert.deepEqual(past.map((m) => m.event), ['end']);
  const junk = parse(await (await h.app.request('/runs/r1/events', { headers: { cookie, 'last-event-id': 'abc' } })).text());
  assert.equal(junk.filter((m) => m.event === 'trace').length, 3, 'an unreadable Last-Event-ID replays everything');
});

test('a live event pushed after connect arrives in order with the next id, then the end', async () => {
  const runs = new FakeRuns();
  runs.add('r1', [ev(0), ev(1)], 'running');
  const { h, cookie } = await setup(runs);
  const res = await h.app.request('/runs/r1/events', { headers: { cookie } });
  const first = await readUntil(res, (t) => parse(t).filter((m) => m.event === 'trace').length >= 2);
  assert.equal(runs.count('r1'), 1);
  runs.push('r1', ev(2));
  runs.push('r1', ev(3));
  runs.states.set('r1', 'done');
  let text = first.text;
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await first.reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const messages = parse(text);
  assert.deepEqual(messages.map((m) => m.id ?? m.event), ['0', '1', '2', '3', 'end']);
  assert.equal(runs.count('r1'), 0);
});

test('an unknown run is 404 before streaming and a missing cookie is 401', async () => {
  const runs = new FakeRuns();
  runs.add('r1', [ev(0)], 'done');
  const { h, cookie } = await setup(runs);
  const unknown = await h.app.request('/runs/nope/events', { headers: { cookie } });
  assert.equal(unknown.status, 404);
  assert.doesNotMatch(unknown.headers.get('content-type') ?? '', /event-stream/);
  assert.equal(runs.count('nope'), 0);
  const anon = await h.app.request('/runs/r1/events');
  assert.equal(anon.status, 401);
  assert.equal(runs.replayCalls, 1, 'only the 404 probe touched the source, the anonymous request never did');
});

test('the default source knows no run: every run is 404', async () => {
  const h = makeApp({ mode: 'replay' });
  const cookie = await createTestSession(h.app);
  assert.equal((await h.app.request('/runs/anything/events', { headers: { cookie } })).status, 404);
});

test('the stream response has Cache-Control no-store and nosniff', async () => {
  const runs = new FakeRuns();
  runs.add('r1', [ev(0)], 'done');
  const { h, cookie } = await setup(runs);
  const res = await h.app.request('/runs/r1/events', { headers: { cookie } });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  await res.text();
});

test('aborting the request unsubscribes and leaves no timer running', async () => {
  const runs = new FakeRuns();
  runs.add('r1', [ev(0)], 'running');
  const { h, cookie } = await setup(runs);
  const timers = () => process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length;
  const before = timers();
  const controller = new AbortController();
  const res = await h.app.request('/runs/r1/events', { headers: { cookie }, signal: controller.signal });
  const got = await readUntil(res, (t) => t.includes('event: trace'));
  assert.equal(runs.count('r1'), 1);
  assert.ok(timers() > before, 'the stream has timers while it runs');
  await got.reader.cancel();
  for (let i = 0; i < 50 && (runs.count('r1') > 0 || timers() > before); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs.count('r1'), 0);
  assert.ok(timers() <= before, 'every interval was cleared');
});

test('replay and subscribe run back to back with no await between them', async () => {
  let microtaskRan = false;
  let order = '';
  const source: RunEventSource = {
    replay() {
      order += 'replay;';
      queueMicrotask(() => {
        microtaskRan = true;
      });
      return [ev(0)];
    },
    subscribe() {
      order += `subscribe(microtask ran: ${microtaskRan});`;
      return () => {
        order += 'unsubscribe;';
      };
    },
    stateOf: () => 'done',
  };
  const { h, cookie } = await setup(source);
  await (await h.app.request('/runs/r1/events', { headers: { cookie } })).text();
  assert.match(order, /^replay;subscribe\(microtask ran: false\);/);
});

test('every 15 seconds a ": ping" comment is written, every second the state is asked', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    const runs = new FakeRuns();
    runs.add('r1', [], 'running');
    let asked = 0;
    const counting: RunEventSource = { replay: (id) => runs.replay(id), subscribe: (id, cb) => runs.subscribe(id, cb), stateOf: (id) => (asked++, runs.stateOf(id)) };
    const { h, cookie } = await setup(counting);
    const res = await h.app.request('/runs/r1/events', { headers: { cookie } });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
    await turn();
    const askedBefore = asked;
    mock.timers.tick(1000);
    await turn();
    mock.timers.tick(1000);
    await turn();
    assert.ok(asked - askedBefore >= 2, `stateOf asked ${asked - askedBefore} times in 2 seconds`);
    for (let i = 0; i < 13; i++) {
      mock.timers.tick(1000);
      await turn();
    }
    const { value } = await reader.read();
    assert.equal(new TextDecoder().decode(value).includes(': ping'), true);
    runs.states.set('r1', 'done');
    mock.timers.tick(1000);
    await turn();
    let text = '';
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value: v } = await reader.read();
      if (done) break;
      text += decoder.decode(v);
    }
    assert.match(text, /event: end/);
  } finally {
    mock.timers.reset();
  }
});

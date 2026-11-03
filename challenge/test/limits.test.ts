import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdmissionControl, SlidingWindow, SpendLedger } from '../src/limits.ts';
import { DEFAULT_LIMITS } from '../src/limits.ts';
import { NEAR, near, output, row, rig } from './helpers.ts';

const code = async (r: ReturnType<typeof rig>, who: string, text = 'invoice'): Promise<string> => {
  const a = await r.built.admission.admit(who, text);
  if (a.ok) {
    a.ticket.settle({ costUsd: '0', movedYocto: 0n });
    return 'ok';
  }
  return a.code;
};

test('window: allows max, refuses the next with a retry time, frees after the window', () => {
  let now = 1_000_000;
  const w = new SlidingWindow(2, 60_000, () => now);
  assert.equal(w.check('a'), null);
  w.record('a');
  w.record('a');
  const refused = w.check('a');
  assert.ok(refused !== null && refused.retryAfterMs > 0 && refused.retryAfterMs <= 60_000);
  assert.equal(w.check('b'), null);
  now += 60_001;
  assert.equal(w.check('a'), null);
});

test('window: unrecord gives one hit back; a table past its bound refuses a new key (fail closed)', () => {
  const w = new SlidingWindow(1, 60_000, () => 5);
  w.record('a');
  assert.notEqual(w.check('a'), null);
  w.unrecord('a');
  assert.equal(w.check('a'), null);
  const full = new SlidingWindow(5, 60_000, () => 5);
  for (let i = 0; i < 10_000; i += 1) full.record(`k${String(i)}`);
  assert.notEqual(full.check('new'), null);
  assert.equal(full.check('k1'), null);
});

test('per visitor limit, then the global limit, in that order of keys', async () => {
  const r = rig({ perIpMax: 2, globalMax: 3 });
  assert.equal(await code(r, 'a'), 'ok');
  assert.equal(await code(r, 'a'), 'ok');
  assert.equal(await code(r, 'a'), 'rate_ip');
  assert.equal(await code(r, 'b'), 'ok');
  assert.equal(await code(r, 'c'), 'rate_global');
  r.clock.now += DEFAULT_LIMITS.globalWindowMs + 1;
  assert.equal(await code(r, 'c'), 'ok');
});

test('a refused attempt counts for nothing', async () => {
  const r = rig({ perIpMax: 1, dailyMax: 2 });
  assert.equal(await code(r, 'a'), 'ok');
  for (let i = 0; i < 20; i += 1) assert.equal(await code(r, 'a'), 'rate_ip');
  assert.equal(await code(r, 'b'), 'ok');
  assert.equal(await code(r, 'c'), 'daily_cap');
  r.clock.now += 24 * 3_600_000;
  assert.equal(await code(r, 'c'), 'ok');
});

test('size: empty and too long are refused before anything is counted', async () => {
  const r = rig({ maxChars: 10, perIpMax: 1 });
  assert.equal(await code(r, 'a', '   '), 'empty');
  assert.equal(await code(r, 'a', 'x'.repeat(11)), 'too_long');
  assert.equal(await code(r, 'a', 'x'.repeat(10)), 'ok');
  assert.equal(await code(r, 'a', '\u{1F600}'.repeat(10)), 'rate_ip');
});

test('door and kill switch: recorded mode shuts door a, the PAUSED switch stops everything', async () => {
  assert.equal(await code(rig({}, 'recorded'), 'a'), 'live_off');
  const r = rig();
  r.paused.value = true;
  assert.equal(await code(r, 'a'), 'paused');
  r.paused.value = false;
  assert.equal(await code(r, 'a'), 'ok');
});

test('concurrency: at most maxInFlight attempts hold a slot, abort and settle free it', async () => {
  const r = rig({ maxInFlight: 2 });
  const a = await r.built.admission.admit('a', 'x');
  const b = await r.built.admission.admit('b', 'x');
  assert.ok(a.ok && b.ok);
  assert.equal(await code(r, 'c'), 'busy');
  if (a.ok) a.ticket.abort();
  assert.equal(await code(r, 'c'), 'ok');
  if (b.ok) b.ticket.settle({ costUsd: '0', movedYocto: 0n });
  assert.equal(await code(r, 'd'), 'ok');
});

test('abort refunds the visitor window, daily count and spend reservation', async () => {
  const r = rig({ perIpMax: 1, dailyMax: 1 });
  const a = await r.built.admission.admit('a', 'x');
  assert.ok(a.ok);
  if (a.ok) a.ticket.abort();
  assert.equal(await code(r, 'a'), 'ok');
});

test('model spend cap: reserved before the call, settled after, closes the door at the cap', async () => {
  const r = rig({ llmCapUsd: '0.05', llmEstimateUsd: '0.02', maxInFlight: 5 });
  const a = await r.built.admission.admit('a', 'x');
  const b = await r.built.admission.admit('b', 'x');
  assert.ok(a.ok && b.ok);
  // two reservations of 0.02 are held: a third would reach 0.06
  assert.equal(await code(r, 'c'), 'llm_cap');
  if (a.ok) a.ticket.settle({ costUsd: '0.03', movedYocto: 0n });
  if (b.ok) b.ticket.settle({ costUsd: '0.01', movedYocto: 0n });
  assert.equal(r.built.admission.spentUsd(), '0.04');
  assert.equal(await code(r, 'c'), 'llm_cap');
  assert.equal(r.built.admission.spentUsd(), '0.04');
});

test('spend ledger: persisted across a restart; an unreadable file stops the start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ch-spend-'));
  const path = join(dir, 'spend.json');
  const l = new SpendLedger(path, 1_000_000_000n);
  l.add(250_000_000n);
  assert.equal(new SpendLedger(path, 1_000_000_000n).spentNano, 250_000_000n);
  assert.equal(new SpendLedger(path, 200_000_000n).fits(1n), false);
  writeFileSync(path, '{"spentNano": "-5"}');
  assert.throws(() => new SpendLedger(path, 1n));
  writeFileSync(path, 'not json');
  assert.throws(() => new SpendLedger(path, 1n));
});

test('NEAR float: an unknown balance or a low one closes the door and refunds the attempt', async () => {
  const r = rig({ perIpMax: 1, nearFloatMinYocto: near(5) }, 'live', true);
  r.probe.value = 'throw';
  assert.equal(await code(r, 'a'), 'float_unknown');
  r.probe.value = null;
  assert.equal(await code(r, 'a'), 'float_unknown');
  r.probe.value = 4n * NEAR;
  assert.equal(await code(r, 'a'), 'float_low');
  r.probe.value = 5n * NEAR;
  assert.equal(await code(r, 'a'), 'ok');
  assert.equal(await code(r, 'a'), 'rate_ip');
});

test('NEAR daily cap: once the day has let the cap through to booked payees the door closes until the next UTC day', async () => {
  const r = rig({ nearDailyCapYocto: near(10) });
  const a = await r.built.admission.admit('a', 'x');
  assert.ok(a.ok);
  if (a.ok) a.ticket.settle({ costUsd: '0', movedYocto: 10n * NEAR });
  assert.equal(await code(r, 'b'), 'float_low');
  r.clock.now += 24 * 3_600_000;
  assert.equal(await code(r, 'b'), 'ok');
});

test('a double settle or abort after settle changes nothing', async () => {
  const r = rig({ llmEstimateUsd: '0.02', llmCapUsd: '0.05' });
  const a = await r.built.admission.admit('a', 'x');
  assert.ok(a.ok);
  if (a.ok) {
    a.ticket.settle({ costUsd: '0.01', movedYocto: 0n });
    a.ticket.settle({ costUsd: '0.01', movedYocto: 0n });
    a.ticket.abort();
  }
  assert.equal(r.built.admission.spentUsd(), '0.01');
  assert.ok(new AdmissionControl({ limits: DEFAULT_LIMITS, clock: () => 0, paused: () => false, liveEnabled: true, ledger: new SpendLedger(null, 1n), floatProbe: null }) instanceof AdmissionControl);
  assert.equal(output().payments[0]?.amount, row().amount);
});

// AIR-300: the autopilot stream is deterministic, its attacks are real bench cases, and the driver counts a mini stream exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, generateStream, loadRawCases, streamJson, streamSha256 } from '../scripts/gen-autopilot-stream.ts';
import type { Stream, StreamItem } from '../scripts/gen-autopilot-stream.ts';
import { dayTable, ensureVerdictCli, rememberEntry, runStream, summaryLine } from '../scripts/autopilot.ts';

const NEAR_UNIT = 10n ** 24n;
const near = (whole: number): string => (BigInt(whole) * NEAR_UNIT).toString();
const OWNER = 1;
const BOOK = 2;
const UNTRUSTED_EMAIL = (1 << 5) | (1 << 12);

test('the generator is deterministic for a seed and differs across seeds', () => {
  const a = streamSha256(generateStream(23));
  const b = streamSha256(generateStream(23));
  assert.equal(a, b);
  assert.notEqual(a, streamSha256(generateStream(24)));
});

test('the committed stream is what seed 23 generates', () => {
  const committed = readFileSync(join(REPO_ROOT, 'bench', 'autopilot', 'stream.json'), 'utf8');
  assert.equal(committed, streamJson(generateStream(23)));
});

test('the stream spans seven days with about 70 items and every attack names a real bench case', () => {
  const stream = generateStream(23);
  assert.ok(stream.items.length >= 60 && stream.items.length <= 80, `items: ${stream.items.length}`);
  assert.deepEqual([...new Set(stream.items.map((i) => i.day))].sort(), [1, 2, 3, 4, 5, 6, 7]);
  const ids = new Set(loadRawCases().map((c) => c.id));
  const attacks = stream.items.filter((i) => i.kind === 'attack');
  assert.ok(attacks.length >= 10);
  for (const a of attacks) assert.ok(a.case_id !== undefined && ids.has(a.case_id), `unknown case ${String(a.case_id)}`);
  for (const i of stream.items.filter((x) => x.kind !== 'attack')) assert.equal(i.case_id, undefined);
});

// ---- the driver on a 6-item stream with known counts ----
function item(idx: number, day: number, kind: StreamItem['kind'], payee: string, whole: number, recipient: number, asset = 'near', bounded = true): StreamItem {
  const task_id = `mini-${idx}`;
  return {
    idx,
    day,
    time: `10:0${idx}`,
    kind,
    task_id,
    bounds: bounded ? { [payee]: near(whole) } : {},
    request: { task_id, action_index: 0, asset, payee, amount: near(whole), labels: { recipient, amount: recipient === UNTRUSTED_EMAIL ? UNTRUSTED_EMAIL : OWNER, pc: OWNER }, evm: null },
  };
}

function miniStream(): Stream {
  return {
    seed: 0,
    day0: 20749,
    setup: {
      assets: { near: { hard_cap: near(100), daily_cap: near(1000), max_fee_per_gas: '0', max_gas: '0' } },
      book: { 'near:landlord.testnet': { cap: null, daily_untrusted_budget: '0', daily_limit: near(20) } },
    },
    items: [
      item(1, 1, 'recurring', 'near:landlord.testnet', 5, BOOK), // allow
      item(2, 1, 'attack', 'near:evil.testnet', 5, UNTRUSTED_EMAIL, 'near', false), // escalate OutsideTask, owner rejects
      item(3, 1, 'attack', 'near:evil.testnet', 5, UNTRUSTED_EMAIL, 'zzz', false), // block UnknownAsset
      item(4, 1, 'new_vendor', 'near:vendor.testnet', 2, OWNER), // escalate NewRecipient, owner approves
      item(5, 1, 'recurring', 'near:vendor.testnet', 2, OWNER), // allow after remember, ask again without
      item(6, 2, 'recurring', 'near:vendor.testnet', 2, OWNER), // allow after remember, ask again without
    ],
  };
}

test('the driver counts a mini stream: allow, block, ask then allow after remember', async () => {
  const cli = ensureVerdictCli();
  const r = await runStream(miniStream(), cli, { remember: true });
  assert.equal(r.mode, 'remember');
  assert.equal(r.paid, 3);
  assert.equal(r.blocked, 1);
  assert.equal(r.asked, 2);
  assert.equal(r.approved, 1);
  assert.equal(r.rejected, 1);
  assert.equal(r.remembered, 1);
  assert.equal(r.attacks_paid, 0);
  assert.deepEqual(
    r.days.map((d) => [d.day, d.total, d.paid, d.blocked, d.legit_asked, d.attack_asked]),
    [
      [1, 5, 2, 1, 1, 1],
      [2, 1, 1, 0, 0, 0],
    ],
  );
  assert.equal(r.legit_asked + r.attack_asked, r.asked);
  assert.match(summaryLine(r), /^AUTOPILOT paid=3 blocked=1 asked=2 attacks_paid=0 ask_rate_day1=40\.00 ask_rate_day7=0\.00 legit_asked=1 attack_asked=1 mode=remember$/);
  assert.ok(dayTable(r).includes('remembered'));
});

test('the same mini stream without remember asks about the vendor every time', async () => {
  const r = await runStream(miniStream(), ensureVerdictCli(), { remember: false });
  assert.equal(r.mode, 'no-remember');
  assert.equal(r.paid, 1);
  assert.equal(r.blocked, 1);
  assert.equal(r.asked, 4);
  assert.equal(r.legit_asked, 3);
  assert.equal(r.attack_asked, 1);
  assert.equal(r.approved, 3);
  assert.equal(r.remembered, 0);
  assert.equal(r.attacks_paid, 0);
});

test('the remember rule: cap 2 times the amount, daily 4 times, never above the hard cap', () => {
  const s = miniStream();
  const e = rememberEntry(s, item(9, 1, 'new_vendor', 'near:v.testnet', 10, OWNER));
  assert.deepEqual(e, { cap: near(20), daily_untrusted_budget: '0', daily_limit: near(40) });
  const big = rememberEntry(s, item(9, 1, 'new_vendor', 'near:v.testnet', 70, OWNER));
  assert.deepEqual(big, { cap: near(100), daily_untrusted_budget: '0', daily_limit: near(280) });
  assert.equal(rememberEntry(s, item(9, 1, 'new_vendor', 'near:v.testnet', 101, OWNER)), null);
});

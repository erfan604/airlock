// AIR-185: buildTask, the refusals and the S30 guard (a runtime that sends bounds or a preview that differ from the console's own).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { toOwnerBounds } from '@airlock/runtime/analyze';
import { checkPlan, decodeOwnerTask, planSha256 } from '@airlock/runtime/dsl';
import fixture from '../fixtures/preview-u01.json' with { type: 'json' };
import type { ChainSnapshot } from '../src/chain/reads.ts';
import { guardRuntime, isReadOnlyDraft } from '../src/preview/api.ts';
import type { RuntimeDraft } from '../src/preview/api.ts';
import { buildTask, uuidv7 } from '../src/preview/preview.ts';
import type { BuildResult } from '../src/preview/preview.ts';

const ref = (name: string, path?: string[]) => (path === undefined ? { ref: name } : { ref: name, path });
const transfer = (to: unknown, amount: unknown) => ({ action: 'transfer', args: { to, amount, asset: 'near' } });
const READ_MAIL = { let: 'mail', call: 'read_inbox' };
const EXTRACT_INV = { let: 'inv', extract: { from: ref('mail'), schema: { amount: 'amount', vendor: 'text' } } };
const LOOKUP_LANDLORD = { let: 'who', lookup: { key: 'landlord' } };

const INSTRUCTION = fixture.instruction;
const RAND10 = Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]);
const SALT = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const rand = (n: number): Uint8Array => (n === 10 ? RAND10 : n === 16 ? SALT : new Uint8Array(n));
const env = { agentId: 'agent.testnet', contractId: 'policy.testnet', rand };

function snap(over: Partial<ChainSnapshot> = {}): ChainSnapshot {
  return {
    book: fixture.snapshot.book as unknown as ChainSnapshot['book'],
    assets: fixture.snapshot.assets as unknown as ChainSnapshot['assets'],
    policy: fixture.snapshot.policy,
    taskKey: null,
    blockMs: fixture.blockMs,
    ...over,
  };
}

const build = (plan: unknown, instruction: string, s: ChainSnapshot = snap()): BuildResult => buildTask(checkPlan(plan), instruction, s, env);

function built(r: BuildResult) {
  assert.equal(r.ok, true, r.ok ? '' : r.refusal.text);
  if (!r.ok) throw new Error('unreachable');
  return r;
}

function refused(r: BuildResult) {
  assert.equal(r.ok, false);
  if (r.ok) throw new Error('unreachable');
  return r.refusal;
}

test('uuidv7: 48 bit big-endian millisecond timestamp, version 7, variant 10, the rest from the ten random bytes', () => {
  assert.equal(uuidv7(1_800_000_000_000, RAND10), '01a3185c-5000-7011-a233-445566778899');
  assert.match(uuidv7(0, new Uint8Array(10).fill(0xff)), /^00000000-0000-7fff-bfff-ffffffffffff$/);
  assert.throws(() => uuidv7(1, new Uint8Array(9)));
});

test('buildTask U01: id, chain time, bounds, hashes and bytes, with the browser clock stubbed to 1', () => {
  const realNow = Date.now;
  Date.now = () => 1;
  try {
    const r = built(build(fixture.plan, INSTRUCTION));
    assert.equal(r.task.task_id, '01a3185c-5000-7011-a233-445566778899');
    assert.equal(r.task.tag, 'airlock-task-v1');
    assert.equal(r.task.contract_id, 'policy.testnet');
    assert.equal(r.task.agent_id, 'agent.testnet');
    assert.equal(r.task.issued_ms, fixture.blockMs);
    assert.equal(r.task.expires_ms, fixture.blockMs + 900_000);
    assert.equal(r.task.max_actions, 1);
    assert.deepEqual(r.task.bounds, [{ payee_key: 'near:accountant.testnet', max_total: '5000000000000000000000000' }]);
    assert.equal(r.task.plan_sha256, planSha256(checkPlan(fixture.plan)));
    assert.equal(r.task.instruction_sha256_salted, createHash('sha256').update(SALT).update(INSTRUCTION, 'utf8').digest('hex'));
    assert.equal(r.saltHex, '0102030405060708090a0b0c0d0e0f10');
    assert.deepEqual(decodeOwnerTask(r.bytes), r.task);
    assert.deepEqual(toOwnerBounds(r.analysis), r.task.bounds);
  } finally {
    Date.now = realNow;
  }
});

test('buildTask: a policy TTL of 600000 shortens the task to ten minutes', () => {
  const r = built(build(fixture.plan, INSTRUCTION, snap({ policy: { flags: { max_task_actions: 20, max_task_ttl_ms: '600000' } } })));
  assert.equal(r.task.expires_ms, r.task.issued_ms + 600_000);
});

test('amounts are BigInt: a literal 1.1 NEAR renders 1.1 NEAR and its bytes carry 1100000000000000000000000', () => {
  const r = built(build([LOOKUP_LANDLORD, transfer(ref('who'), '1.1')], 'Pay landlord 1.1 NEAR'));
  assert.deepEqual(r.task.bounds, [{ payee_key: 'near:landlord.testnet', max_total: '1100000000000000000000000' }]);
  const pay = r.card.find((l) => l.label === 'Pay up to');
  assert.equal(pay?.value, '1.1 NEAR to near:landlord.testnet');
  assert.notEqual(BigInt(1.1 * 1e24), 1100000000000000000000000n);
});

test('refusal: 60 NEAR in the owner words is above the quick cap', () => {
  const r = refused(build([LOOKUP_LANDLORD, transfer(ref('who'), '60')], 'Pay landlord 60 NEAR'));
  assert.deepEqual(r, { code: 'ExceedsQuickCap', text: 'above the quick cap in this version' });
});

test('refusal: 40 payments is TooManyActions and the text lists what to split', () => {
  const plan = [READ_MAIL, { for: 'item', in: ref('mail'), max: 20, do: [transfer('landlord.testnet', '0.1'), transfer('accountant.testnet', '0.1')] }];
  const r = refused(build(plan, 'Pay landlord 0.1 NEAR for each'));
  assert.equal(r.code, 'TooManyActions');
  assert.ok(r.text.startsWith('This plan can make more payments than one task allows. Split it into smaller requests.'), r.text);
  assert.ok(r.text.includes('This plan can make 40 payments and one task allows 20. Split it.'), r.text);
});

test('refusal: nothing bounded is NoBounds', () => {
  const r = refused(build([READ_MAIL, EXTRACT_INV, LOOKUP_LANDLORD, transfer(ref('who'), ref('inv', ['amount']))], INSTRUCTION));
  assert.deepEqual(r, { code: 'NoBounds', text: 'Nothing in this plan can be approved in advance, every payment would ask you. Not available in this version.' });
});

test('refusal: two loops are UnsupportedShape', () => {
  const loop = (name: string) => ({ for: name, in: ref('mail'), max: 2, do: [transfer('landlord.testnet', '1')] });
  const r = refused(build([READ_MAIL, loop('a'), loop('b')], 'Pay landlord 1 NEAR'));
  assert.deepEqual(r, { code: 'UnsupportedShape', text: 'This plan has more than one loop. Not supported in this version.' });
});

test('refusal: more than 16 payees is TooManyBounds', () => {
  const rows = [...fixture.snapshot.book] as unknown as [string, unknown][];
  for (let i = 0; i < 16; i++) rows.push([`near:payee${i}.testnet`, { cap: '1000000000000000000000000', daily_untrusted_budget: '0', daily_limit: '20000000000000000000000000', label: `p${i}` }]);
  const plan = [...Array.from({ length: 17 }, (_, i) => ({ let: `w${i}`, lookup: { key: i === 16 ? 'landlord' : `p${i}` } })), ...Array.from({ length: 17 }, (_, i) => transfer(ref(`w${i}`), '0.1'))];
  const r = refused(build(plan, 'Pay 0.1 NEAR to each', snap({ book: rows as unknown as ChainSnapshot['book'] })));
  assert.deepEqual(r, { code: 'TooManyBounds', text: 'This plan pays more than 16 payees. Split it.' });
});

// == the S30 guard ==
const goodPlan = checkPlan(fixture.plan);
const draft = (over: Partial<RuntimeDraft> = {}): RuntimeDraft => ({ draftId: 'd1', planSha256: planSha256(goodPlan), plan: fixture.plan, extras: {}, ...over });
const guard = (d: RuntimeDraft) => guardRuntime(d, snap(), env, INSTRUCTION);

test('S30 guard: extras that differ, a hash that does not match and a plan that fails the checker each refuse', () => {
  const own = built(build(fixture.plan, INSTRUCTION));
  const ownBounds = toOwnerBounds(own.analysis);
  const ownPreview = own.analysis.preview.map((l) => l.text);

  const bounds = guard(draft({ extras: { bounds: [{ payee_key: 'near:accountant.testnet', max_total: '50000000000000000000000000' }] } }));
  assert.equal('ok' in bounds ? 'ok' : bounds.code, 'RuntimeDiffers');
  const preview = guard(draft({ extras: { preview: ['Pay the accountant 5 NEAR'] } }));
  assert.equal('ok' in preview ? 'ok' : preview.code, 'RuntimeDiffers');
  const hash = guard(draft({ planSha256: 'f'.repeat(64) }));
  assert.equal('ok' in hash ? 'ok' : hash.code, 'PlanHashMismatch');
  const bad = guard(draft({ plan: [{ bogus: 1 }] }));
  assert.equal('ok' in bad ? 'ok' : bad.code, 'PlanInvalid');
  for (const r of [bounds, preview, hash, bad]) assert.ok(!('ok' in r) && r.text.endsWith('Not signing.'));

  // extras equal to the console's own, or absent, are fine, and the build that comes back is the one to sign
  for (const extras of [{}, { bounds: ownBounds }, { preview: ownPreview }, { bounds: ownBounds, preview: ownPreview }]) {
    const ok = guard(draft({ extras }));
    assert.ok('ok' in ok && ok.ok, 'text' in ok ? ok.text : '');
    if ('ok' in ok) assert.deepEqual(ok.build.task.bounds, ownBounds);
  }
});

test('S30 guard: a refusal of the analyzer passes through with its own closed text', () => {
  const r = guardRuntime(draft({ plan: [LOOKUP_LANDLORD, transfer(ref('who'), '60')], planSha256: planSha256(checkPlan([LOOKUP_LANDLORD, transfer(ref('who'), '60')])) }), snap(), env, 'Pay landlord 60 NEAR');
  assert.ok(!('ok' in r));
  if (!('ok' in r)) assert.equal(r.code, 'ExceedsQuickCap');
});

// == AIR-293: the console decides for itself that a draft is read only ==
test('read only: a plan with no action step is read only by the console own analysis, a paying plan and a bad hash are not', () => {
  const summary = [READ_MAIL, { let: 'sum', extract: { from: ref('mail'), schema: { summary: 'text' } } }, { say: ref('sum', ['summary']) }];
  const hash = planSha256(checkPlan(summary));
  const ro = (d: RuntimeDraft) => isReadOnlyDraft(d, snap(), INSTRUCTION);
  assert.equal(ro(draft({ plan: summary, planSha256: hash })), true);
  assert.equal(ro(draft({ plan: summary, planSha256: 'f'.repeat(64) })), false);
  assert.equal(ro(draft({ plan: [{ bogus: 1 }] })), false);
  assert.equal(ro(draft()), false, 'the U01 plan pays');
  const unbounded = [READ_MAIL, EXTRACT_INV, LOOKUP_LANDLORD, transfer(ref('who'), ref('inv', ['amount']))];
  assert.equal(ro(draft({ plan: unbounded, planSha256: planSha256(checkPlan(unbounded)) })), false, 'NoBounds with an action is a refusal, not a read only run');
  // a runtime that sends readOnly on a paying plan changes nothing: the flag is not an input
  assert.equal(ro({ ...draft(), extras: { ...draft().extras }, readOnly: true } as RuntimeDraft), false);
});

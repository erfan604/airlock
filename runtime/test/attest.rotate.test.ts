// AIR-309 offline tests: a pin miss records what was seen, the sample groups builds, and rotation refuses a build whose other checks fail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadPolicy, verifyReport, verifyWithCollateral } from '../src/attest/index.ts';
import type { Attestation, QuoteVerifier, VerifyDeps, VerifyPolicy } from '../src/attest/index.ts';
import { buildsOf, formatSample, rotatePolicy, sampleBuilds } from '../src/attest/builds.ts';

const policy = loadPolicy() as VerifyPolicy & Record<string, unknown>;
const fx = JSON.parse(readFileSync(new URL('./fixtures/attest/fixture.json', import.meta.url), 'utf8')) as {
  model: string;
  nonce: string;
  raw_body: string;
  quotes: Record<string, { collateral: Record<string, unknown>; now_secs: number }>;
  gpu: Record<string, { overall: boolean }>;
};
const h = (s: string) => createHash('sha256').update(s).digest('hex');
const replayQuote: QuoteVerifier = async (q) => {
  const rec = fx.quotes[h(q)];
  if (rec === undefined) throw new Error('no recorded collateral for this quote');
  return verifyWithCollateral(q, rec.collateral, rec.now_secs);
};
const deps: VerifyDeps = {
  verifyQuote: replayQuote,
  verifyGpu: async (p) => fx.gpu[h(JSON.stringify(p))]?.overall ?? false,
  now: () => new Date('2026-11-03T15:15:30Z'),
};
const failed = (a: Attestation) => a.checks.filter((c) => !c.ok).map((c) => c.name);
const withPins = (edit: (m: any) => void): VerifyPolicy & Record<string, unknown> => {
  const c = JSON.parse(JSON.stringify(policy)) as any;
  edit(c.models[fx.model]);
  return c;
};
const verify = (pol: VerifyPolicy, body = fx.raw_body) => verifyReport({ rawBody: body, model: fx.model, nonce: fx.nonce }, deps, pol);
const real = buildsOf(fx.raw_body).models[0]!;
const now = new Date('2026-11-05T10:00:00Z');

// the recorded report presented as a new build: the compose hash is unpinned and so are the OS measurements, as a redeploy would be
const unpinned = withPins((m) => {
  m.compose_hash = ['00'.repeat(32)];
  m.rtmr2 = ['11'.repeat(48)];
});

test('a pin miss stores every measurement and the compose hash that were seen, in the failing rows only', async () => {
  const a = await verify(unpinned);
  assert.deepEqual(failed(a), ['model.os_measurements', 'model.compose_pin']);
  const os = a.checks.find((c) => c.name === 'model.os_measurements')!.detail;
  for (const v of [real.mr_td, real.rtmr0, real.rtmr1, real.rtmr2]) assert.ok(os.includes(v), v);
  assert.ok(a.checks.find((c) => c.name === 'model.compose_pin')!.detail.includes(real.compose_hash));
  assert.ok(a.checks.filter((c) => c.ok).every((c) => !c.detail.includes('seen ')));
  const empty = await verify(withPins((m) => (m.compose_hash = [])));
  assert.ok(empty.checks.find((c) => c.name === 'model.compose_pin')!.detail.includes(real.compose_hash));
});

test('sampleBuilds groups reports by build and names the failing rows', async () => {
  const pols = [policy, unpinned, policy];
  let i = 0;
  const s = await sampleBuilds(3, async () => ({ att: await verify(pols[i++]!), body: fx.raw_body }));
  assert.equal(s.n, 3);
  // same build every time: one group, 2 of 3 verified
  assert.equal(s.distinct.length, 1);
  assert.equal(s.distinct[0]!.count, 3);
  assert.equal(s.distinct[0]!.verified, 2);
  assert.deepEqual(s.distinct[0]!.failed_rows, ['model.compose_pin', 'model.os_measurements']);
  assert.deepEqual(s.distinct[0]!.model_build, real);
  const other = JSON.parse(fx.raw_body);
  other.model_attestations[0].info.tcb_info.app_compose += ' ';
  const t = await sampleBuilds(2, (() => { let k = 0; return async () => (k++ === 0 ? { att: await verify(policy), body: fx.raw_body } : { att: await verify(policy, JSON.stringify(other)), body: JSON.stringify(other) }); })());
  assert.equal(t.distinct.length, 2);
  assert.ok(formatSample(t).join('\n').includes(real.compose_hash));
  const none = await sampleBuilds(1, async () => ({ att: { ...(await verify(policy)), status: 'UNATTESTED' as const, report_sha256: '', checks: [{ name: 'report_fetched', ok: false, detail: 'x' }] }, body: '' }));
  assert.equal(none.distinct[0]!.model_build, null);
  await assert.rejects(sampleBuilds(0, async () => assert.fail('no run')), /positive integer/);
});

const rotate = async (pol: VerifyPolicy & Record<string, unknown>, body: string, hash = real.compose_hash, reason = 'NEAR image provenance checked') =>
  rotatePolicy({ model: fx.model, composeHash: hash, reason, now, policy: pol, rawBody: body, current: await verify(pol, body), verifyWith: (p) => verify(p, body) });

test('rotation adds the build and logs date, report hash and reason when only the pins fail', async () => {
  const old = withPins((m) => {
    m.mr_td = ['22'.repeat(48)];
    m.rtmr0 = ['22'.repeat(48)];
    m.rtmr1 = ['22'.repeat(48)];
    m.rtmr2 = ['22'.repeat(48)];
    m.compose_hash = ['33'.repeat(32)];
  });
  const oldBefore = JSON.stringify(old);
  const { policy: next, entry } = await rotate(old, fx.raw_body);
  const m = (next.models as any)[fx.model];
  assert.deepEqual(m.compose_hash, ['33'.repeat(32), real.compose_hash]);
  assert.deepEqual(m.rtmr2, ['22'.repeat(48), real.rtmr2]);
  assert.equal(entry.report_sha256, h(fx.raw_body));
  assert.equal(entry.reason, 'NEAR image provenance checked');
  assert.equal(entry.date, now.toISOString());
  assert.deepEqual((next._rotate_log as unknown[]).at(-1), entry);
  assert.equal(next._rotate, policy._rotate);
  // rotation returns a new policy and never mutates its input (the committed log may already name the hash)
  assert.equal(JSON.stringify(old), oldBefore);
  assert.equal(((old.models as any)[fx.model].compose_hash as string[]).includes(real.compose_hash), false);
  assert.equal((await verify(next)).status, 'VERIFIED');
});

test('rotation refuses a build whose other checks fail, and the policy is untouched', async () => {
  const before = JSON.stringify(policy);
  const bad = JSON.parse(fx.raw_body);
  bad.model_attestations[0].info.tcb_info.app_compose += ' ';
  const body = JSON.stringify(bad);
  const hash = buildsOf(body).models[0]!.compose_hash;
  await assert.rejects(rotate(unpinned, body, hash), /other checks fail: model\.mrconfigid/);
  const gpuBad = JSON.parse(fx.raw_body);
  gpuBad.model_attestations[0].nvidia_payload = JSON.stringify({ ...JSON.parse(gpuBad.model_attestations[0].nvidia_payload), arch: 'X' });
  await assert.rejects(rotate(unpinned, JSON.stringify(gpuBad)), /model\.gpu/);
  const gw = withPins(() => undefined);
  (gw as any).gateway.compose_hash = ['00'.repeat(32)];
  await assert.rejects(rotate(withPins((m) => (m.compose_hash = ['00'.repeat(32)])) && gw, fx.raw_body), /gateway\.compose_pin/);
  // the committed policy may already carry a reviewed rotation; refused rotations must leave it exactly as it was
  assert.equal(JSON.stringify(policy), before);
  assert.equal(JSON.stringify(loadPolicy()), before);
});

test('rotation refuses an already pinned build, a wrong hash, no reason and no report', async () => {
  await assert.rejects(rotate(policy, fx.raw_body), /nothing to rotate/);
  await assert.rejects(rotate(unpinned, fx.raw_body, 'ab'.repeat(32)), /not ab/);
  await assert.rejects(rotate(unpinned, fx.raw_body, real.compose_hash, '  '), /reason/);
  await assert.rejects(rotate(unpinned, fx.raw_body, 'xyz'), /64 lowercase hex/);
  await assert.rejects(rotatePolicy({ model: fx.model, composeHash: real.compose_hash, reason: 'r', now, policy: unpinned, rawBody: '', current: { ...(await verify(unpinned)), status: 'UNATTESTED' }, verifyWith: async () => assert.fail('not asked') }), /no report/);
});

test('rotation re-verifies the whole report: a policy that still fails after widening is refused', async () => {
  await assert.rejects(
    rotatePolicy({ model: fx.model, composeHash: real.compose_hash, reason: 'r', now, policy: unpinned, rawBody: fx.raw_body, current: await verify(unpinned), verifyWith: async (p) => ({ ...(await verify(p)), status: 'FAILED', checks: [{ name: 'model.gpu', ok: false, detail: 'late' }] }) }),
    /still fails: model\.gpu/,
  );
});

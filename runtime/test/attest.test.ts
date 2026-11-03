// AIR-303 offline tests. The fixture is a real report fetched from NEAR AI Cloud on 2026-11-03 (scripts/attest.ts --fixture) together with the
// quote collateral and the NVIDIA answer of that run, so the Intel signature chain is verified for real at the recorded time, offline.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { attestModel, loadPolicy, nrasVerdict, replayRtmr3, unattested, verifyReport, verifyWithCollateral } from '../src/attest/index.ts';
import type { Attestation, QuoteVerifier, VerifyDeps, VerifyPolicy } from '../src/attest/index.ts';

const policy = loadPolicy();

interface Fixture {
  model: string;
  nonce: string;
  raw_body: string;
  quotes: Record<string, { collateral: Record<string, unknown>; now_secs: number }>;
  gpu: Record<string, { overall: boolean }>;
  record: Attestation;
}
const fx = JSON.parse(readFileSync(new URL('./fixtures/attest/fixture.json', import.meta.url), 'utf8')) as Fixture;
const h = (s: string) => createHash('sha256').update(s).digest('hex');

const replayQuote: QuoteVerifier = async (quoteHex) => {
  const rec = fx.quotes[h(quoteHex)];
  if (rec === undefined) throw new Error('no recorded collateral for this quote');
  return verifyWithCollateral(quoteHex, rec.collateral, rec.now_secs);
};
const deps: VerifyDeps = {
  verifyQuote: replayQuote,
  verifyGpu: async (payload) => {
    const rec = fx.gpu[h(JSON.stringify(payload))];
    if (rec === undefined) throw new Error('no recorded NRAS answer for this payload');
    return rec.overall;
  },
  now: () => new Date('2026-11-03T15:15:30Z'),
};

const failed = (a: Attestation): string[] => a.checks.filter((c) => !c.ok).map((c) => c.name);
const withBody = (edit: (b: Record<string, any>) => void): string => {
  const b = JSON.parse(fx.raw_body) as Record<string, any>;
  edit(b);
  return JSON.stringify(b);
};
const run = (rawBody: string, over: { model?: string; nonce?: string } = {}, d: VerifyDeps = deps, pol: VerifyPolicy = policy) =>
  verifyReport({ rawBody, model: over.model ?? fx.model, nonce: over.nonce ?? fx.nonce }, d, pol);

test('a good report verifies, every check passes and the record names the hash', async () => {
  const a = await run(fx.raw_body);
  assert.equal(a.status, 'VERIFIED', JSON.stringify(failed(a)));
  assert.deepEqual(failed(a), []);
  assert.equal(a.report_sha256, h(fx.raw_body));
  assert.equal(a.tcb_status, 'UpToDate');
  assert.equal(a.model, 'z-ai/glm-5.3-flash');
  assert.match(a.signing_address ?? '', /^0x[0-9a-f]{40}$/);
  assert.match(a.compose_hash ?? '', /^[0-9a-f]{64}$/);
  for (const name of ['gateway.quote', 'gateway.report_data', 'model.id', 'model.quote', 'model.td_debug_off', 'model.nonce_echo', 'model.report_data', 'model.event_log', 'model.mrconfigid', 'model.gpu']) {
    assert.ok(a.checks.some((c) => c.name === name && c.ok), name);
  }
  assert.equal(JSON.stringify(a).toLowerCase().includes('secure'), false);
});

test('the recorded record of the live run matches a fresh offline verification', async () => {
  const a = await run(fx.raw_body);
  assert.equal(fx.record.status, 'VERIFIED');
  assert.equal(a.report_sha256, fx.record.report_sha256);
  assert.deepEqual(a.checks, fx.record.checks);
});

test('a wrong nonce fails the nonce echo and the report data binding', async () => {
  const other = '11'.repeat(32);
  const a = await run(fx.raw_body, { nonce: other });
  assert.equal(a.status, 'FAILED');
  for (const n of ['gateway.nonce_echo', 'gateway.report_data', 'model.nonce_echo', 'model.report_data', 'model.gpu']) assert.ok(failed(a).includes(n), n);
});

test('a nonce that is not 32 bytes of hex fails nonce_format', async () => {
  const a = await run(fx.raw_body, { nonce: 'abcd' });
  assert.ok(failed(a).includes('nonce_format'));
});

test('a wrong model fails model.id', async () => {
  const a = await run(fx.raw_body, { model: 'z-ai/glm-5.3' });
  assert.ok(failed(a).includes('model.id'));
  assert.equal(a.status, 'FAILED');
});

test('a report for another model fails model.id', async () => {
  const a = await run(withBody((b) => (b.model_attestations[0].model_name = 'Qwen/Qwen3.8-27B')));
  assert.deepEqual(failed(a), ['model.id']);
});

test('a tampered quote fails the Intel signature check', async () => {
  const a = await run(withBody((b) => {
    const q: string = b.model_attestations[0].intel_quote;
    b.model_attestations[0].intel_quote = q.slice(0, 2000) + (q[2000] === '0' ? '1' : '0') + q.slice(2001);
  }));
  assert.equal(a.status, 'FAILED');
  assert.ok(failed(a).includes('model.quote'));
});

test('a swapped signing address fails the report data binding', async () => {
  const a = await run(withBody((b) => (b.model_attestations[0].signing_address = `0x${'ab'.repeat(20)}`)));
  assert.deepEqual(failed(a), ['model.report_data']);
});

test('a tampered app_compose fails the MRCONFIGID check', async () => {
  const a = await run(withBody((b) => (b.model_attestations[0].info.tcb_info.app_compose += ' ')));
  assert.deepEqual(failed(a), ['model.mrconfigid']);
});

test('a tampered event log fails the RTMR3 replay', async () => {
  const a = await run(withBody((b) => {
    const e = b.model_attestations[0].event_log.find((x: any) => x.imr === 3 && x.event_payload !== '');
    e.event_payload = e.event_payload.slice(0, -2) + (e.event_payload.endsWith('00') ? '01' : '00');
  }));
  assert.deepEqual(failed(a), ['model.event_log']);
});

test('tampered GPU evidence fails the GPU check', async () => {
  const a = await run(withBody((b) => {
    const p = JSON.parse(b.model_attestations[0].nvidia_payload);
    p.arch = 'TAMPERED';
    b.model_attestations[0].nvidia_payload = JSON.stringify(p);
  }));
  assert.deepEqual(failed(a), ['model.gpu']);
});

test('a GPU payload with another nonce fails before NRAS is asked', async () => {
  let asked = 0;
  const a = await run(
    withBody((b) => {
      const p = JSON.parse(b.model_attestations[0].nvidia_payload);
      p.nonce = '22'.repeat(32);
      b.model_attestations[0].nvidia_payload = JSON.stringify(p);
    }),
    {},
    { ...deps, verifyGpu: async () => (asked++, true) },
  );
  assert.deepEqual(failed(a), ['model.gpu']);
  assert.equal(asked, 0);
});

test('a missing GPU payload and an NRAS failure both fail model.gpu', async () => {
  const none = await run(withBody((b) => delete b.model_attestations[0].nvidia_payload));
  assert.deepEqual(failed(none), ['model.gpu']);
  const nras = await run(fx.raw_body, {}, { ...deps, verifyGpu: async () => false });
  assert.deepEqual(failed(nras), ['model.gpu']);
});

test('missing or empty model_attestations fails model.present and is never VERIFIED', async () => {
  for (const edit of [(b: any) => delete b.model_attestations, (b: any) => (b.model_attestations = [])]) {
    const a = await run(withBody(edit));
    assert.equal(a.status, 'FAILED');
    assert.ok(failed(a).includes('model.present'));
  }
});

test('a tampered gateway report fails its own checks', async () => {
  const a = await run(withBody((b) => (b.gateway_attestation.request_nonce = '33'.repeat(32))));
  assert.deepEqual(failed(a), ['gateway.nonce_echo']);
});

test('TDX debug mode and an unaccepted TCB status are rejected', async () => {
  const real = await replayQuote(JSON.parse(fx.raw_body).model_attestations[0].intel_quote);
  const debug: VerifyDeps = {
    ...deps,
    verifyQuote: async (q) => {
      const v = await replayQuote(q);
      return v.report_data === real.report_data ? { ...v, td_attributes: '01' + v.td_attributes.slice(2) } : v;
    },
  };
  assert.ok(failed(await run(fx.raw_body, {}, debug)).includes('model.td_debug_off'));
  const old: VerifyDeps = { ...deps, verifyQuote: async (q) => ({ ...(await replayQuote(q)), status: 'OutOfDate', advisory_ids: ['INTEL-SA-00000'] }) };
  const a = await run(fx.raw_body, {}, old);
  assert.ok(failed(a).includes('model.quote') && failed(a).includes('gateway.quote'));
  assert.equal(a.checks.find((c) => c.name === 'model.quote')?.detail.includes('OutOfDate'), true);
});

test('a malformed body fails closed without throwing', async () => {
  for (const body of ['', 'not json', '[]', 'null', '{}']) {
    const a = await run(body);
    assert.notEqual(a.status, 'VERIFIED', body);
  }
});

const withPins = (edit: (m: any, g: any) => void): VerifyPolicy => {
  const c = JSON.parse(JSON.stringify(policy)) as any;
  edit(c.models[fx.model], c.gateway);
  return c as VerifyPolicy;
};

test('the pinned policy file passes the recorded report and has the rows os_measurements and compose_pin for both reports', async () => {
  const a = await run(fx.raw_body);
  for (const n of ['gateway.os_measurements', 'gateway.compose_pin', 'model.os_measurements', 'model.compose_pin']) assert.ok(a.checks.some((c) => c.name === n && c.ok), n);
});

test('an otherwise valid report with an unpinned MRTD, RTMR or compose hash fails with the named row', async () => {
  for (const key of ['mr_td', 'rtmr0', 'rtmr1', 'rtmr2'] as const) {
    const a = await run(fx.raw_body, {}, deps, withPins((m) => (m[key] = ['00'.repeat(48)])));
    assert.deepEqual(failed(a), ['model.os_measurements'], key);
    assert.equal(a.status, 'FAILED');
  }
  const g = await run(fx.raw_body, {}, deps, withPins((_m, gw) => (gw.rtmr2 = ['00'.repeat(48)])));
  assert.deepEqual(failed(g), ['gateway.os_measurements']);
  const c = await run(fx.raw_body, {}, deps, withPins((m) => (m.compose_hash = ['00'.repeat(32)])));
  assert.deepEqual(failed(c), ['model.compose_pin']);
  const gc = await run(fx.raw_body, {}, deps, withPins((_m, gw) => (gw.compose_hash = ['00'.repeat(32)])));
  assert.deepEqual(failed(gc), ['gateway.compose_pin']);
});

test('no policy, a model with no pins, or an empty list fails: nothing is skipped', async () => {
  const none = await run(fx.raw_body, {}, deps, { acceptedTcb: ['UpToDate'] });
  assert.equal(none.status, 'FAILED');
  assert.deepEqual(failed(none).sort(), ['gateway.compose_pin', 'gateway.os_measurements', 'model.compose_pin', 'model.os_measurements']);
  const other = await run(fx.raw_body, {}, deps, { ...policy, models: {} });
  assert.deepEqual(failed(other).sort(), ['model.compose_pin', 'model.os_measurements']);
  const empty = await run(fx.raw_body, {}, deps, withPins((m) => (m.rtmr0 = [])));
  assert.deepEqual(failed(empty), ['model.os_measurements']);
});

test('a report whose tcb_info disagrees with the verified quote fails os_measurements', async () => {
  const a = await run(withBody((b) => (b.model_attestations[0].info.tcb_info.rtmr1 = '11'.repeat(48))));
  assert.deepEqual(failed(a), ['model.os_measurements']);
});

test('loadPolicy rejects a missing file and a file with no accepted TCB status', () => {
  assert.throws(() => loadPolicy(new URL('file:///nonexistent/attest-policy.json')));
  const dir = mkdtempSync(join(tmpdir(), 'attest-'));
  writeFileSync(join(dir, 'p.json'), '{"acceptedTcb":[]}');
  assert.throws(() => loadPolicy(pathToFileURL(join(dir, 'p.json'))), /acceptedTcb/);
});

test('the RTMR3 replay is deterministic and rejects a wrong event digest', () => {
  const log = [{ imr: 3, event_type: 134217729, event: 'app-id', event_payload: 'aa', digest: '' }];
  assert.equal(replayRtmr3(log).length, 48);
  assert.deepEqual(replayRtmr3(log), replayRtmr3(JSON.stringify(log)));
  assert.throws(() => replayRtmr3([{ ...log[0], digest: '00'.repeat(48) }]), /digest mismatch/);
});

test('no key, an HTTP error and a network error give UNATTESTED, and the key is never in the record', async () => {
  const noKey = await attestModel(fx.model, { env: {}, policy, fetch: async () => assert.fail('no request without a key') });
  assert.equal(noKey.status, 'UNATTESTED');
  assert.equal(noKey.report_sha256, '');
  const key = 'sk-test-key-that-must-not-leak';
  const http401 = await attestModel(fx.model, { env: { NEARAI_API_KEY: key }, fetch: async () => new Response('no', { status: 401 }) });
  assert.equal(http401.status, 'UNATTESTED');
  const boom = await attestModel(fx.model, { env: { NEARAI_API_KEY: key }, fetch: async () => { throw new Error(`failed with ${key}`); } });
  assert.equal(boom.status, 'UNATTESTED');
  for (const a of [noKey, http401, boom]) assert.equal(JSON.stringify(a).includes(key), false);
  assert.equal(unattested('m', 'n', 'r', new Date(0)).status, 'UNATTESTED');
});

test('attestModel sends a fresh nonce, the canonical model and no aliasing, and verifies the answer', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const a = await attestModel(fx.model, {
    env: { NEARAI_API_KEY: 'k' },
    nonce: fx.nonce,
    now: deps.now,
    deps,
    fetch: async (url, init) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(fx.raw_body, { status: 200 });
    },
  });
  assert.equal(a.status, 'VERIFIED');
  assert.equal(seen.length, 1);
  const u = new URL(seen[0]!.url);
  assert.equal(u.searchParams.get('model'), fx.model);
  assert.equal(u.searchParams.get('provider'), 'near');
  assert.equal(u.searchParams.get('nonce'), fx.nonce);
  assert.equal(seen[0]!.headers['x-no-aliasing'], 'true');
  const r1 = await attestModel(fx.model, { env: { NEARAI_API_KEY: 'k' }, fetch: async (url) => (seen.push({ url: String(url), headers: {} }), new Response('{}', { status: 200 })), deps });
  const r2 = await attestModel(fx.model, { env: { NEARAI_API_KEY: 'k' }, fetch: async (url) => (seen.push({ url: String(url), headers: {} }), new Response('{}', { status: 200 })), deps });
  assert.notEqual(r1.nonce, r2.nonce);
});

test('nrasVerdict accepts only a JWT whose overall result is true', () => {
  const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  assert.equal(nrasVerdict([['JWT', jwt({ 'x-nvidia-overall-att-result': true })], {}]), true);
  assert.equal(nrasVerdict([['JWT', jwt({ 'x-nvidia-overall-att-result': false })], {}]), false);
  assert.equal(nrasVerdict([['JWT', jwt({ 'x-nvidia-overall-att-result': 'true' })], {}]), false);
  assert.equal(nrasVerdict({}), false);
  assert.equal(nrasVerdict([['JWT', 'nodots']]), false);
});

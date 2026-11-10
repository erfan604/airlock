// AIR-350: the pool asks the MPC network about one Base Sepolia payment, and anyone checks the stored answer back on NEAR.
// Offline: the payload hash, the signature check against the real answers of 2026-11-10, the answer parser, the plan, the preconditions,
// the live gates, the one-retry budget and the web entry. Nothing here touches a network; every chain read and the send are injected.
//   pnpm tsx --test scripts/credit-base-readback.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CALLER_DEFAULT,
  EXPECTED_DOMAIN,
  EXPECTED_SIGNER,
  FEE_YOCTO,
  GAS_TGAS,
  LIVE_ENV,
  POOL,
  buildPlan,
  checkSignature,
  evaluatePreconditions,
  nearKeyToUncompressed,
  parseAnswer,
  payloadHash,
  run,
  webEntry,
} from './credit-base-readback.ts';
import type { Deps, Plan, ReceiptInfo, Row, SendResult } from './credit-base-readback.ts';

// ---- real vectors of 2026-11-10 ----
const TX = '943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63';
const BLOCK_HASH = '893086c54971173851743c46e6681fe661759407c23f08aac081ab2bd0617605';
const HASH = 'b38ee2231f49b349ec841663233049d739fbd6b00c786b729cda8814b92021c1';
/** public_key({"domain_id":3}) of v1.signer-prod.testnet, read in the AIR-342 spike */
const DOMAIN3_KEY = 'secp256k1:2KGCoy2pZt7n85QfJnQzCT1eHySuNpquUfNc8ySpRbr15F5kqU7agJYjfo5RkrzNd4tZimDFv2wAZri7RRZ32qj1';
/** the signature text the pool stored in the rehearsal (get_base_check) */
const REHEARSAL_SIG =
  '{"scheme":"Secp256k1","big_r":{"affine_point":"03861018cefdce0bc42e60c7ba94ba41c2252758060d329a725b63c82649713d6f"},"s":{"scalar":"45d11a0d693686dbbd01634251ddfe5b014217e81a273e7c4fdc8c99ac9d177a"},"recovery_id":0}';
/** the signature the signer returned to the AIR-342 spike for the same hash */
const SPIKE_SIG =
  '{"scheme":"Secp256k1","big_r":{"affine_point":"026424731f59b19f8b6fbe27e2c7c0d080920fa54011cc29b2767e601efffbe43e"},"s":{"scalar":"5866b53569dcbe797b3049205f49d911c7a1bf03be94d03d2dac6e28fab6871e"},"recovery_id":0}';

const view = (signature = REHEARSAL_SIG, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tx_id: TX,
  payload_hash: HASH,
  signature,
  asked_by: 'lp1.airlock-credit-c1108d.testnet',
  recorded_ms: '1762804230000',
  ...over,
});

/** Flip one hex digit at position i of s (0 to 1, anything else to 0). */
const flip = (s: string, i: number): string => `${s.slice(0, i)}${s[i] === '0' ? '1' : '0'}${s.slice(i + 1)}`;

const sigOf = (text: string) => {
  const a = parseAnswer(view(text), TX);
  assert.ok(a.ok, a.ok ? '' : a.reason);
  return a.answer.signature;
};

// ---- the payload hash ----

test('the payload hash builder reproduces the signed hash of the rehearsal and the spike', () => {
  assert.equal(payloadHash(TX, BLOCK_HASH), HASH);
  assert.equal(payloadHash(`0x${TX}`, `0x${BLOCK_HASH.toUpperCase()}`), HASH, '0x and case do not matter');
});

test('the payload hash changes with the tx id and with the block hash', () => {
  assert.notEqual(payloadHash(flip(TX, 10), BLOCK_HASH), HASH);
  assert.notEqual(payloadHash(TX, flip(BLOCK_HASH, 63)), HASH);
  assert.throws(() => payloadHash(TX.slice(1), BLOCK_HASH), /64 hex/);
  assert.throws(() => payloadHash(TX, `${BLOCK_HASH}00`), /64 hex/);
});

// ---- the signature check ----

test('the domain 3 key decodes to an uncompressed secp256k1 point', () => {
  const k = nearKeyToUncompressed(DOMAIN3_KEY);
  assert.match(k, /^0x04[0-9a-f]{128}$/);
  assert.throws(() => nearKeyToUncompressed('ed25519:2KGCoy2pZt7n85QfJnQz'), /secp256k1:/);
  assert.throws(() => nearKeyToUncompressed('secp256k1:2KGC0y'), /base58/);
});

test('both real signatures verify against the domain 3 key', async () => {
  for (const text of [REHEARSAL_SIG, SPIKE_SIG]) {
    const r = await checkSignature(HASH, sigOf(text), DOMAIN3_KEY);
    assert.equal(r.ok, true, r.reason);
  }
});

test('each real signature fails with any one hex digit of r or s changed', async () => {
  for (const text of [REHEARSAL_SIG, SPIKE_SIG]) {
    const sig = sigOf(text);
    // r is the x coordinate (digits 2 to 65 of the affine point); a changed x may not be on the curve, which also fails
    for (let i = 2; i < 66; i += 1) {
      const r = await checkSignature(HASH, { ...sig, bigR: flip(sig.bigR, i) }, DOMAIN3_KEY);
      assert.equal(r.ok, false, `r digit ${i}`);
    }
    for (let i = 0; i < 64; i += 1) {
      const r = await checkSignature(HASH, { ...sig, s: flip(sig.s, i) }, DOMAIN3_KEY);
      assert.equal(r.ok, false, `s digit ${i}`);
    }
    assert.equal((await checkSignature(HASH, { ...sig, recoveryId: 1 }, DOMAIN3_KEY)).ok, false, 'the other recovery id');
    assert.equal((await checkSignature(HASH, { ...sig, bigR: `04${sig.bigR.slice(2)}` }, DOMAIN3_KEY)).ok, false, 'not a compressed point');
  }
});

test('each real signature fails over a hash with one digit changed and over a different hash', async () => {
  for (const text of [REHEARSAL_SIG, SPIKE_SIG]) {
    const sig = sigOf(text);
    for (const i of [0, 17, 31, 63]) assert.equal((await checkSignature(flip(HASH, i), sig, DOMAIN3_KEY)).ok, false, `hash digit ${i}`);
    assert.equal((await checkSignature(payloadHash(TX, flip(BLOCK_HASH, 0)), sig, DOMAIN3_KEY)).ok, false, 'another block hash');
  }
});

test('a signature checked against another key fails', async () => {
  const other = 'secp256k1:2KGCoy2pZt7n85QfJnQzCT1eHySuNpquUfNc8ySpRbr15F5kqU7agJYjfo5RkrzNd4tZimDFv2wAZri7RRZ32qj2';
  assert.equal((await checkSignature(HASH, sigOf(REHEARSAL_SIG), other)).ok, false);
});

// ---- the answer parser ----

test('the answer parser reads the stored view and refuses anything malformed', () => {
  const a = parseAnswer(view(), TX);
  assert.ok(a.ok);
  assert.equal(a.answer.payloadHash, HASH);
  assert.equal(a.answer.signature.recoveryId, 0);
  assert.equal(a.answer.signature.bigR.slice(0, 2), '03');
  assert.equal(parseAnswer(view(undefined, { payload_hash: HASH.toUpperCase() }), TX).ok, true, 'an upper case hash is read');
  const bad: Array<[unknown, RegExp]> = [
    [null, /no answer/],
    ['x', /not an object/],
    [view(undefined, { tx_id: flip(TX, 0) }), /another transaction/],
    [view(undefined, { payload_hash: HASH.slice(1) }), /payload_hash/],
    [view('not json'), /signature/],
    [view(REHEARSAL_SIG.replace('Secp256k1', 'Ed25519')), /scheme/],
    [view(REHEARSAL_SIG.replace('"recovery_id":0', '"recovery_id":2')), /recovery_id/],
    [view(REHEARSAL_SIG.replace('45d11a0d', '45d11a0')), /scalar/],
    [view(undefined, { asked_by: '' }), /asked_by/],
    [view(undefined, { recorded_ms: 12 }), /recorded_ms/],
  ];
  for (const [raw, why] of bad) {
    const r = parseAnswer(raw, TX);
    assert.equal(r.ok, false, JSON.stringify(raw));
    if (!r.ok) assert.match(r.reason, why);
  }
});

// ---- the plan and the preconditions ----

test('the plan: one call of check_base_payment on the pool with 0.01 NEAR and 100 Tgas, the id without 0x', () => {
  const p = buildPlan(`0x${TX}`, CALLER_DEFAULT);
  assert.deepEqual(p, { contract: POOL, method: 'check_base_payment', args: { tx_id: TX }, depositYocto: FEE_YOCTO, deposit: '0.01 NEAR', gasTgas: 100, signer: CALLER_DEFAULT });
  assert.equal(POOL, 'pool.airlock-credit-c1108d.testnet');
  assert.ok(GAS_TGAS >= 60, 'the pool refuses under 60 Tgas');
  assert.equal(FEE_YOCTO, 10n ** 22n);
});

const goodReceipt: ReceiptInfo = { status: '0x1', blockHash: `0x${BLOCK_HASH}`, blockNumber: 53570093n, from: '0x16c0', to: '0x7eaf', valueWei: 20000000000000000n, finalizedHead: 57076215n, canonicalHash: `0x${BLOCK_HASH}` };
const goodConfig = { mpc_signer: EXPECTED_SIGNER, domain_id: EXPECTED_DOMAIN, fee: FEE_YOCTO.toString() };
const pre = (over: Partial<Parameters<typeof evaluatePreconditions>[0]> = {}) =>
  evaluatePreconditions({ config: goodConfig, receipt: goodReceipt, caller: CALLER_DEFAULT, callerYocto: 3n * 10n ** 24n, existing: null, plan: buildPlan(TX, CALLER_DEFAULT), ...over });

test('the preconditions pass for the expected signer, a success receipt and a funded plain caller', () => {
  assert.deepEqual(pre(), { action: 'send', stops: [] });
});

test('a pool config with another signer or domain, or no config, stops before sending', () => {
  for (const config of [{ ...goodConfig, mpc_signer: 'v1.signer.testnet' }, { ...goodConfig, domain_id: 0 }, null, { ...goodConfig, fee: (FEE_YOCTO + 1n).toString() }]) {
    const r = pre({ config });
    assert.equal(r.action, 'stop', JSON.stringify(config));
  }
});

test('a Base receipt with failure status, or none, stops before sending', () => {
  assert.equal(pre({ receipt: { ...goodReceipt, status: '0x0' } }).action, 'stop');
  assert.equal(pre({ receipt: null }).action, 'stop');
});

test('the caller must be a plain LP account of ours, not the pool, card, agent or issuer, with at least 0.5 NEAR', () => {
  for (const c of ['pool.airlock-credit-c1108d.testnet', 'card.airlock-credit-c1108d.testnet', 'agent.airlock-credit-c1108d.testnet', 'airlock-credit-c1108d.testnet', 'someone.testnet']) {
    assert.equal(pre({ caller: c, plan: buildPlan(TX, c) }).action, 'stop', c);
  }
  assert.equal(pre({ callerYocto: 5n * 10n ** 23n - 1n }).action, 'stop');
  assert.equal(pre({ callerYocto: 5n * 10n ** 23n }).action, 'send');
});

test('an id already recorded goes to verify and sends nothing, even with a poor caller', () => {
  assert.deepEqual(pre({ existing: view(), callerYocto: 0n }), { action: 'verify', stops: [] });
});

// ---- the run, with injected chain reads and send ----

type H = { deps: Deps; sent: Plan[]; lines: string[]; rows: Row[]; weatherCalls: number };
function harness(over: {
  config?: unknown;
  existing?: unknown;
  existingAfter?: unknown;
  receipt?: ReceiptInfo | null;
  send?: (n: number) => SendResult;
  rows?: Row[];
  weather?: { code: number; line: string };
  answerFile?: unknown;
} = {}): H {
  const sent: Plan[] = [];
  const lines: string[] = [];
  const rows: Row[] = [...(over.rows ?? [])];
  const h: H = { deps: undefined as unknown as Deps, sent, lines, rows, weatherCalls: 0 };
  h.deps = {
    log: (s) => lines.push(s),
    nearView: async (contract, method) => {
      if (contract === POOL && method === 'get_base_check_config') {
        if (over.config === 'old') throw new Error('wasm execution failed with error: MethodResolveError(MethodNotFound)');
        return over.config ?? goodConfig;
      }
      if (contract === POOL && method === 'get_base_check') {
        if (over.config === 'old') throw new Error('wasm execution failed with error: MethodResolveError(MethodNotFound)');
        return sent.length > 0 ? (over.existingAfter ?? view()) : (over.existing ?? null);
      }
      if (contract === EXPECTED_SIGNER && method === 'public_key') return DOMAIN3_KEY;
      throw new Error(`unexpected view ${contract} ${method}`);
    },
    balanceYocto: async () => 3n * 10n ** 24n,
    receipt: async () => (over.receipt === undefined ? goodReceipt : over.receipt),
    weather: () => {
      h.weatherCalls += 1;
      return over.weather ?? { code: 0, line: 'SIGNER WEATHER GOOD n=100 p50=4.2s p90=4.9s failed=0 (0.0%) window=60m domain=0 signer=v1.signer-prod.testnet' };
    },
    send: async (plan) => {
      sent.push(plan);
      return over.send ? over.send(sent.length) : { tx: `NearTx${sent.length}`, refused: '', events: [{ event: 'base_payment_checked', data: { tx_id: TX } }], signerFailure: '' };
    },
    readRows: () => rows,
    appendRow: (r) => rows.push(r),
    rowsBaseTx: () => `0x${TX}`,
    readAnswerFile: () => over.answerFile ?? view(),
  };
  return h;
}

const LIVE = { [LIVE_ENV]: '1' };
const timeout = (): SendResult => ({
  tx: 'NearTxT',
  refused: '',
  events: [{ event: 'base_payment_unchecked', data: { tx_id: TX, reason: 'the signer call failed or timed out' } }],
  signerFailure: 'Smart contract panicked: Request has timed out.',
});

test('dry mode calls send zero times, reads, and ends DRY RUN nothing sent', async () => {
  const h = harness();
  assert.equal(await run([], {}, h.deps), 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.weatherCalls, 0);
  assert.equal(h.lines.at(-1), 'DRY RUN nothing sent');
  assert.ok(h.lines.some((l) => l.includes(POOL) && l.includes(CALLER_DEFAULT)));
  assert.ok(h.lines.some((l) => l.includes(`payload hash ${HASH}`)), 'the expected hash from the Base block hash');
});

test('dry mode against an old pool reports POOL NOT UPGRADED and continues', async () => {
  const h = harness({ config: 'old' });
  assert.equal(await run(['--tx', `0x${TX}`], {}, h.deps), 0);
  assert.ok(h.lines.some((l) => l.startsWith('POOL NOT UPGRADED')));
  assert.equal(h.lines.at(-1), 'DRY RUN nothing sent');
  assert.equal(h.sent.length, 0);
});

test('live exits 2 without both --live and the env gate, and sends nothing', async () => {
  for (const [argv, env] of [[['--live'], {}], [['--live'], { [LIVE_ENV]: 'yes' }]] as const) {
    const h = harness();
    assert.equal(await run([...argv], { ...env }, h.deps), 2);
    assert.equal(h.sent.length, 0);
  }
  const envOnly = harness();
  assert.equal(await run([], LIVE, envOnly.deps), 0, 'the env alone is a dry run');
  assert.equal(envOnly.sent.length, 0);
});

test('live with a pool config naming another signer stops before sending', async () => {
  const h = harness({ config: { ...goodConfig, mpc_signer: 'evil.testnet' } });
  assert.equal(await run(['--live'], LIVE, h.deps), 1);
  assert.equal(h.sent.length, 0);
  assert.equal(h.weatherCalls, 0);
});

test('live against an old pool stops before sending', async () => {
  const h = harness({ config: 'old' });
  assert.equal(await run(['--live'], LIVE, h.deps), 1);
  assert.equal(h.sent.length, 0);
});

test('a Base receipt with failure status stops live before sending and fails --verify', async () => {
  const failed = { ...goodReceipt, status: '0x0' };
  const live = harness({ receipt: failed });
  assert.equal(await run(['--live'], LIVE, live.deps), 1);
  assert.equal(live.sent.length, 0);
  const v = harness({ receipt: failed, existing: view() });
  assert.equal(await run(['--verify'], {}, v.deps), 1);
  assert.ok(v.lines.some((l) => l.startsWith('FAIL') && l.includes('status')));
  assert.ok(!v.lines.includes('BASE READBACK VERIFY OK'));
});

test('an id already recorded sends nothing and goes to verify', async () => {
  const h = harness({ existing: view() });
  assert.equal(await run(['--live'], LIVE, h.deps), 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.weatherCalls, 0);
  assert.ok(h.lines.some((l) => l.includes('already recorded')));
  assert.equal(h.lines.at(-1), 'BASE READBACK VERIFY OK');
});

test('SLOW or BAD signer weather stops before sending', async () => {
  for (const w of [{ code: 1, line: 'SIGNER WEATHER SLOW n=50' }, { code: 2, line: 'SIGNER WEATHER BAD n=50' }]) {
    const h = harness({ weather: w });
    assert.equal(await run(['--live'], LIVE, h.deps), 1);
    assert.equal(h.sent.length, 0);
  }
});

test('live sends one call, verifies the stored answer and prints the web entry with exactly tx_id and near_tx', async () => {
  const h = harness();
  assert.equal(await run(['--live'], LIVE, h.deps), 0);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0]?.args, { tx_id: TX });
  assert.equal(h.sent[0]?.gasTgas, 100);
  assert.equal(h.sent[0]?.deposit, '0.01 NEAR');
  assert.equal(h.rows.length, 1);
  assert.deepEqual(Object.keys(h.rows[0] ?? {}).sort(), ['account', 'link', 'tx', 'what']);
  const entryLine = h.lines.find((l) => l.startsWith('WEB ENTRY '));
  assert.ok(entryLine !== undefined);
  const entry = JSON.parse(entryLine.slice('WEB ENTRY '.length)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(entry).sort(), ['near_tx', 'tx_id']);
  assert.deepEqual(entry, { tx_id: TX, near_tx: 'NearTx1' });
  assert.ok(h.lines.includes('BASE READBACK VERIFY OK'));
});

test('the web entry has exactly the keys tx_id and near_tx', () => {
  const e = webEntry(`0x${TX}`, 'NearTx1');
  assert.deepEqual(Object.keys(e), ['tx_id', 'near_tx']);
  assert.equal(e.tx_id, TX);
});

test('one retry after a signer timeout, then a second retry is refused', async () => {
  const h = harness({ send: () => timeout() });
  assert.equal(await run(['--live'], LIVE, h.deps), 1);
  assert.equal(h.sent.length, 2, 'the call and one retry');
  assert.equal(h.rows.length, 2);
  const again = harness({ send: () => timeout(), rows: h.rows });
  assert.equal(await run(['--live'], LIVE, again.deps), 3);
  assert.equal(again.sent.length, 0, 'a second retry is refused');
});

test('a retry after a timeout that then records the answer verifies it', async () => {
  const h = harness({ send: (n) => (n === 1 ? timeout() : { tx: 'NearTx2', refused: '', events: [{ event: 'base_payment_checked', data: { tx_id: TX } }], signerFailure: '' }) });
  assert.equal(await run(['--live'], LIVE, h.deps), 0);
  assert.equal(h.sent.length, 2);
  assert.ok(h.lines.some((l) => l.includes('"near_tx":"NearTx2"')));
});

test('no retry after a refusal, nor after an unchecked answer that is not a timeout', async () => {
  const refused = harness({ send: () => ({ tx: 'NearTxR', refused: 'Smart contract panicked: this Base transaction is already recorded', events: [], signerFailure: '' }) });
  assert.equal(await run(['--live'], LIVE, refused.deps), 1);
  assert.equal(refused.sent.length, 1);
  const notTimeout = harness({
    send: () => ({ tx: 'NearTxU', refused: '', events: [{ event: 'base_payment_unchecked', data: { tx_id: TX, reason: 'the answer is not JSON' } }], signerFailure: '' }),
  });
  assert.equal(await run(['--live'], LIVE, notTimeout.deps), 1);
  assert.equal(notTimeout.sent.length, 1);
  const signerRefused = harness({
    send: () => ({ tx: 'NearTxS', refused: '', events: [{ event: 'base_payment_unchecked', data: { tx_id: TX, reason: 'the signer call failed or timed out' } }], signerFailure: 'Smart contract panicked: ForeignChainNotAvailable' }),
  });
  assert.equal(await run(['--live'], LIVE, signerRefused.deps), 1);
  assert.equal(signerRefused.sent.length, 1, 'a signer refusal is not a timeout');
  const after = harness({ rows: refused.rows });
  assert.equal(await run(['--live'], LIVE, after.deps), 3, 'a recorded refusal leaves no retry');
  assert.equal(after.sent.length, 0);
});

// ---- --verify ----

test('--verify passes on the stored answer and says what it does not show', async () => {
  const h = harness({ existing: view() });
  assert.equal(await run(['--verify'], {}, h.deps), 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.lines.at(-1), 'BASE READBACK VERIFY OK');
  assert.ok(h.lines.some((l) => /does not name the payee or the amount/.test(l)));
  assert.ok(h.lines.some((l) => l.includes('read from Base by this script') && l.includes('0x7eaf')));
});

test('--verify fails when nothing is recorded, when the pool is old, or when the answer does not match', async () => {
  const none = harness();
  assert.equal(await run(['--verify'], {}, none.deps), 1);
  const old = harness({ config: 'old' });
  assert.equal(await run(['--verify'], {}, old.deps), 1);
  const wrongHash = harness({ existing: view(undefined, { payload_hash: flip(HASH, 5) }) });
  assert.equal(await run(['--verify'], {}, wrongHash.deps), 1);
  const wrongSig = harness({ existing: view(REHEARSAL_SIG.replace('45d11a0d', '45d11a0e')) });
  assert.equal(await run(['--verify'], {}, wrongSig.deps), 1);
  const otherBlock = harness({ existing: view(), receipt: { ...goodReceipt, blockHash: `0x${flip(BLOCK_HASH, 3)}`, canonicalHash: `0x${flip(BLOCK_HASH, 3)}` } });
  assert.equal(await run(['--verify'], {}, otherBlock.deps), 1);
  const unreadable = harness({ existing: view(), receipt: null });
  assert.equal(await run(['--verify'], {}, unreadable.deps), 1, 'an unreadable receipt is not a pass');
  for (const h of [none, old, wrongHash, wrongSig, otherBlock, unreadable]) assert.ok(!h.lines.includes('BASE READBACK VERIFY OK'));
});

test('--verify with --answer-file checks a given answer against an old pool, using the expected signer and domain', async () => {
  const h = harness({ config: 'old', answerFile: view() });
  assert.equal(await run(['--verify', '--tx', `0x${TX}`, '--answer-file', 'x.json'], {}, h.deps), 0);
  assert.equal(h.lines.at(-1), 'BASE READBACK VERIFY OK');
  assert.ok(h.lines.some((l) => l.includes('answer from x.json')));
  const bad = harness({ config: 'old', answerFile: view(SPIKE_SIG.replace('5866', '5867')) });
  assert.equal(await run(['--verify', '--answer-file', 'x.json'], {}, bad.deps), 1);
});

test('--verify fails when the Base block is not finalized as far as the RPC says', async () => {
  const h = harness({ existing: view(), receipt: { ...goodReceipt, finalizedHead: goodReceipt.blockNumber - 1n } });
  assert.equal(await run(['--verify'], {}, h.deps), 1);
  const reorg = harness({ existing: view(), receipt: { ...goodReceipt, canonicalHash: `0x${flip(BLOCK_HASH, 0)}` } });
  assert.equal(await run(['--verify'], {}, reorg.deps), 1);
});

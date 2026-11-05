// AIR-311: the Try page's verdict. (1) The committed web/public/verdict.wasm against the shared vector files (fixtures/verdict-vectors.lines and
// .expect, the 200 cases the Rust crate, Lean and the runtime also read). (2) The wasm against the Rust crate itself on 2,000 generated cases
// (scripts/gen_verdict_cases.py and the diff driver, the same pair scripts/diff-verdict.sh uses for Lean). (3) The committed wasm equals a
// fresh build (scripts/build-verdict-wasm.sh --check). (4) Every preset of web/fixtures/try-world.json gives its expected verdict in default
// and strict mode, and the payee-list guard its expected answer. (2) and (3) need Rust and Python and are skipped without them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HIRED, WORLD, columnsOf, defaultKnobs, formatDollars, parseDollars, payeeListGuard, reasonWords, sourceOf, standIn } from '../src/try/model.ts';
import { REASONS, instantiateVerdict, tagOf } from '../src/try/verdictWasm.ts';
import type { VerdictModule } from '../src/try/verdictWasm.ts';

const web = fileURLToPath(new URL('../', import.meta.url));
const repo = join(web, '..');
const read = (p: string): string => readFileSync(join(repo, p), 'utf8');
const lines = (t: string): string[] => t.split('\n').filter((l) => l !== '');
const cols = (line: string): bigint[] => line.trim().split(/\s+/).map((t) => BigInt(t));

let mod: VerdictModule | null = null;
async function wasm(): Promise<VerdictModule> {
  mod ??= await instantiateVerdict(readFileSync(join(web, 'public', 'verdict.wasm')));
  return mod;
}

const has = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

test('the wasm verdict gives the expected tag on all 200 shared verdict-vectors cases', async () => {
  const m = await wasm();
  const input = lines(read('fixtures/verdict-vectors.lines'));
  const expect = lines(read('fixtures/verdict-vectors.expect'));
  assert.equal(input.length, 200);
  assert.equal(expect.length, 200);
  input.forEach((l, i) => assert.equal(tagOf(m.decide(cols(l))), expect[i], `line ${String(i + 1)}: ${l}`));
});

test('the reason table is the order of ALL_REASONS in the verdict crate', () => {
  const src = read('contracts/airlock-verdict/src/lib.rs');
  const block = /pub const ALL_REASONS: \[Reason; 17\] = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
  assert.deepEqual([...block.matchAll(/Reason::([A-Za-z]+)/g)].map((m) => m[1]), [...REASONS]);
});

test('the wasm and the Rust crate agree on 2,000 generated cases', async (t) => {
  if (!has('cargo', ['--version']) || !has('python3', ['--version'])) return t.skip('needs cargo and python3');
  const m = await wasm();
  const cases = ['uniform 7 750', 'boundary 11 750', 'toggle 13 500']
    .map((s) => s.split(' '))
    .flatMap(([name, seed, n]) => {
      const r = spawnSync('python3', ['scripts/gen_verdict_cases.py', n as string, seed as string, name as string], { cwd: repo, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return lines(r.stdout);
    });
  assert.equal(cases.length, 2000);
  const rust = spawnSync('cargo', ['run', '-q', '--release', '--example', 'diff'], { cwd: join(repo, 'contracts', 'airlock-verdict'), input: `${cases.join('\n')}\n`, encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(rust.status, 0, rust.stderr);
  const tags = lines(rust.stdout);
  assert.equal(tags.length, 2000);
  const kinds = new Set<string>();
  cases.forEach((c, i) => {
    const got = tagOf(m.decide(cols(c)));
    kinds.add(got.split(':')[0] as string);
    assert.equal(got, tags[i], `case ${String(i + 1)}: ${c}`);
  });
  assert.deepEqual([...kinds].sort(), ['allow', 'block', 'escalate']);
});

test('the committed verdict.wasm is byte for byte a fresh build', { timeout: 300_000 }, (t) => {
  if (!has('cargo', ['--version'])) return t.skip('needs cargo');
  const r = spawnSync('bash', ['scripts/build-verdict-wasm.sh', '--check'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /VERDICT WASM OK [0-9a-f]{64}/);
});

test('every preset gives its expected verdict in default and strict mode, and the payee-list guard its answer', async () => {
  const m = await wasm();
  assert.equal(WORLD.presets.length, 5);
  for (const p of WORLD.presets) {
    const r = standIn(p.email);
    assert.equal(r.kind, 'proposal', p.id);
    if (r.kind !== 'proposal') continue;
    const knobs = defaultKnobs();
    assert.equal(tagOf(m.decide(columnsOf(r.proposal, knobs))), p.expect.default, `${p.id} default`);
    assert.equal(tagOf(m.decide(columnsOf(r.proposal, { ...knobs, strict: true }))), p.expect.strict, `${p.id} strict`);
    assert.equal(payeeListGuard(r.proposal), p.expect.guard, `${p.id} guard`);
  }
});

test('AIR-312: every hired-agent preset gives its expected verdict from the real wasm, with the label of the text it came from', async () => {
  const m = await wasm();
  assert.equal(HIRED.presets.length, 4);
  const seen: string[] = [];
  for (const p of HIRED.presets) {
    const r = standIn(p.email, HIRED, sourceOf(p));
    assert.equal(r.kind, 'proposal', p.id);
    if (r.kind !== 'proposal') continue;
    const knobs = defaultKnobs(HIRED);
    const cols = columnsOf(r.proposal, knobs, HIRED);
    // the amount carries the label bit of its channel: web (64) for an invoice or the job post, chat (256) for another agent
    assert.equal(cols[6], sourceOf(p).channel === 'chat' ? 256n : 64n, `${p.id} amount label`);
    assert.equal(tagOf(m.decide(cols)), p.expect.default, `${p.id} default`);
    assert.equal(tagOf(m.decide(columnsOf(r.proposal, { ...knobs, strict: true }, HIRED))), p.expect.strict, `${p.id} strict`);
    assert.equal(payeeListGuard(r.proposal, HIRED), p.expect.guard, `${p.id} guard`);
    seen.push(p.expect.default);
  }
  // the honest bill is paid; the budget grab, the inflated bill and the look-alike are not
  assert.deepEqual(seen, ['allow', 'escalate:OutsideTask', 'escalate:UntrustedAmount', 'escalate:OutsideTask']);
});

test('the cap knob moves the honest invoice and the doctored amount across the line', async () => {
  const m = await wasm();
  const doctored = standIn(WORLD.presets.find((p) => p.id === 'doctored')?.email ?? '');
  assert.equal(doctored.kind, 'proposal');
  if (doctored.kind !== 'proposal') return;
  // a cap above the amount still holds it: the day's budget for amounts read from data is smaller
  assert.equal(tagOf(m.decide(columnsOf(doctored.proposal, { capCents: 200_000n, strict: false }))), 'escalate:UntrustedAmount');
  const honest = standIn(WORLD.presets.find((p) => p.id === 'honest')?.email ?? '');
  assert.equal(honest.kind, 'proposal');
  if (honest.kind !== 'proposal') return;
  assert.equal(tagOf(m.decide(columnsOf(honest.proposal, { capCents: 10_000n, strict: false }))), 'escalate:UntrustedAmount');
  assert.equal(tagOf(m.decide(columnsOf(honest.proposal, { capCents: 18_000n, strict: false }))), 'allow');
});

test('the stand-in agent: accounts win, then another booked payee, then the payee you named; the first dollar amount', () => {
  const a = standIn('Pay $12.50 to someone.near now, ref 99');
  assert.ok(a.kind === 'proposal' && a.proposal.payee.account === 'someone.near' && a.proposal.payee.origin === 'email' && a.proposal.amount.cents === 1250n);
  const b = standIn('send 40 to harbor rent');
  assert.ok(b.kind === 'proposal' && b.proposal.payee.name === 'Harbor Rent' && b.proposal.payee.origin === 'email-book' && b.proposal.amount.cents === 4000n);
  const c = standIn('Invoice total $2,000');
  assert.ok(c.kind === 'proposal' && c.proposal.payee.origin === 'owner' && c.proposal.payee.inTask && c.proposal.amount.cents === 200000n);
  const d = standIn('pay 4 to acct2.testnet');
  assert.ok(d.kind === 'proposal' && d.proposal.amount.cents === 400n, 'the digits of an account are never the amount');
  assert.deepEqual(standIn('no money here'), { kind: 'nothing', why: 'no-amount' });
  assert.deepEqual(standIn('   '), { kind: 'nothing', why: 'empty' });
  assert.deepEqual(standIn('pay $1.234 now'), { kind: 'nothing', why: 'bad-amount' });
});

test('dollars parse and print as BigInt cents', () => {
  assert.equal(parseDollars('1,800.00'), 180000n);
  assert.equal(parseDollars('180.5'), 18050n);
  assert.equal(parseDollars('12,34'), null);
  assert.equal(parseDollars('1.234'), null);
  assert.equal(formatDollars(180000n), '$1,800.00');
  assert.equal(formatDollars(5n), '$0.05');
});

test('every reason has its own plain sentence', () => {
  const r = standIn('Amount due: $180.00');
  assert.ok(r.kind === 'proposal');
  if (r.kind !== 'proposal') return;
  const seen = new Set(REASONS.map((x) => reasonWords(x, r.proposal, defaultKnobs())));
  assert.equal(seen.size, REASONS.length);
});

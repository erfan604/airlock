// AIR-361: the Break the proof page. Every copy in web/public/mutants/manifest.json is the real verdict with one rule taken out
// (scripts/canary/break-proof.tsv, scripts/build-verdict-mutants.sh). For each row: the committed real verdict.wasm refuses the row's
// attack and the copy pays it; the wasm files match their sha256; each cited file:line names its Kani harness or Lean theorem; the patch
// text is the committed patch; the recorded Kani output shows a failing check. The rendered page carries the coverage text word for word
// and passes the banned phrase list. The reproducibility check needs cargo and is skipped without it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { STATIC_ROUTES } from '../vite-static.ts';
import { PAGES } from '../src/pages.ts';
import { ROUTES } from '../src/routes.ts';
import { BreakView } from '../src/break/BreakPage.tsx';
import { COVERAGE, parseManifest, payingCopy, resultOf } from '../src/break/model.ts';
import type { Manifest } from '../src/break/model.ts';
import { instantiateVerdict, tagOf } from '../src/try/verdictWasm.ts';
import type { VerdictModule } from '../src/try/verdictWasm.ts';

const web = fileURLToPath(new URL('../', import.meta.url));
const repo = join(web, '..');
const mutants = join(web, 'public', 'mutants');
const read = (p: string): string => readFileSync(join(repo, p), 'utf8');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function manifest(): Manifest {
  const m = parseManifest(JSON.parse(readFileSync(join(mutants, 'manifest.json'), 'utf8')) as unknown);
  assert.ok(m !== null, 'manifest.json does not parse');
  return m;
}

type TsvRow = { id: string; patch: string; title: string; attack: string; harness: string; lean: string; leanLine: number };
function tsv(): TsvRow[] {
  return read('scripts/canary/break-proof.tsv')
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => {
      const [id, patch, title, attack, harness, leanAt] = l.split('\t') as [string, string, string, string, string, string];
      const [lean, line] = leanAt.split('@') as [string, string];
      return { id, patch, title, attack, harness, lean, leanLine: Number.parseInt(line, 10) };
    });
}

let real: VerdictModule | null = null;
const realWasm = async (): Promise<VerdictModule> => (real ??= await instantiateVerdict(readFileSync(join(web, 'public', 'verdict.wasm'))));
const copyWasm = (id: string): Promise<VerdictModule> => instantiateVerdict(readFileSync(join(mutants, `${id}.wasm`)));

test('the manifest lists the rows of break-proof.tsv, in order, and at least one copy', () => {
  const m = manifest();
  const rows = tsv();
  assert.ok(rows.length >= 1 && rows.length <= 5);
  assert.deepEqual(
    m.copies.map((c) => [c.id, c.patch, c.title, c.attack, c.harness.name, c.lean.name, c.lean.line]),
    rows.map((r) => [r.id, r.patch, r.title, r.attack, r.harness, r.lean, r.leanLine]),
  );
  assert.equal(new Set(m.attacks.map((a) => a.id)).size, m.attacks.length);
  for (const c of m.copies) assert.ok(m.attacks.some((a) => a.id === c.attack), `${c.id}: no attack ${c.attack}`);
});

test('for every copy the real wasm refuses its attack and the copy pays it', async () => {
  const m = manifest();
  const r = await realWasm();
  for (const c of m.copies) {
    const a = m.attacks.find((x) => x.id === c.attack);
    assert.ok(a !== undefined);
    const cols = a.columns.map((v) => BigInt(v));
    const realTag = tagOf(r.decide(cols));
    assert.notEqual(realTag, 'allow', `${c.id}: the real gate allows`);
    assert.equal(realTag, c.realTag, `${c.id}: recorded real tag`);
    const copy = await copyWasm(c.id);
    assert.equal(tagOf(copy.decide(cols)), 'allow', `${c.id}: the copy does not pay`);
    assert.equal(c.copyTag, 'allow');
  }
});

test('each wasm file matches its sha256 and size, and every copy differs from the real gate', () => {
  const m = manifest();
  const realSha = sha(readFileSync(join(web, 'public', 'verdict.wasm')));
  assert.equal(m.realSha256, realSha);
  for (const c of m.copies) {
    const b = readFileSync(join(mutants, `${c.id}.wasm`));
    assert.equal(sha(b), c.sha256, c.id);
    assert.equal(b.length, c.size, c.id);
    assert.notEqual(c.sha256, realSha, `${c.id} is the real gate`);
  }
});

test('each cited file:line names its Kani harness or Lean theorem', () => {
  for (const c of manifest().copies) {
    const k = read(c.harness.file).split('\n')[c.harness.line - 1] ?? '';
    assert.ok(k.includes(`fn ${c.harness.name}(`), `${c.harness.file}:${String(c.harness.line)} is not ${c.harness.name}`);
    const l = read(c.lean.file).split('\n')[c.lean.line - 1] ?? '';
    assert.ok(l.startsWith(`theorem ${c.lean.name} `), `${c.lean.file}:${String(c.lean.line)} is not ${c.lean.name}`);
    assert.ok(c.lean.statement.startsWith(`theorem ${c.lean.name} `) && read(c.lean.file).includes(c.lean.statement), `${c.id}: the Lean statement is not the file's text`);
    const rule = read(c.rule.file).split('\n').slice(c.rule.from - 1, c.rule.to).join('\n');
    assert.ok(/\/\/ Rule \d+/.test(rule), `${c.id}: ${c.rule.file}:${String(c.rule.from)} is not a rule`);
  }
});

test('each patch text equals the committed patch, and the copy lost exactly the lines it names', () => {
  for (const c of manifest().copies) assert.equal(c.patchText, read(`scripts/canary/${c.patch}`), c.id);
});

test('each recorded Kani excerpt shows a failing check of the named harness and a clean control', () => {
  for (const c of manifest().copies) {
    const p = join(mutants, c.kani);
    assert.ok(existsSync(p), `${c.kani} is missing`);
    const t = readFileSync(p, 'utf8');
    assert.ok(t.includes('Status: FAILURE'), `${c.id}: no failing check`);
    assert.ok(t.includes('VERIFICATION:- FAILED'), `${c.id}: no failed verification`);
    assert.ok(t.includes(c.harness.name), `${c.id}: the excerpt does not name ${c.harness.name}`);
    assert.ok(t.includes('VERIFICATION:- SUCCESSFUL'), `${c.id}: no clean control`);
    assert.ok(!/erfan|testnet|\/Users\//i.test(t), `${c.id}: a local path or name in the excerpt`);
  }
});

test('every attack against every copy gives the answer the page shows, and the off diagonal is said honestly', async () => {
  const m = manifest();
  const r = await realWasm();
  for (const c of m.copies) {
    const copy = await copyWasm(c.id);
    for (const a of m.attacks) {
      const cols = a.columns.map((v) => BigInt(v));
      const res = resultOf(a, r.decide(cols), copy.decide(cols));
      assert.equal(res.real.kind === 'paid', tagOf(r.decide(cols)) === 'allow');
      assert.equal(res.copy.kind === 'paid', tagOf(copy.decide(cols)) === 'allow');
      if (a.id === c.attack) assert.equal(res.line, 'The real gate refuses. The broken copy pays.');
      else if (res.copy.kind === 'refused') assert.match(res.line, /This copy also refuses: the rule it lost is not the one this attack needs/);
    }
  }
});

const BRIEF_BANNED = [/formally verified contract/i, /proved secure/i, /unbreakable/i, /\bfirst\b/i, /the proof covers the contract/i, /mathematically impossible to steal/i, /testnet/i, /erfan/i];

function renderedText(m: Manifest, kani: Record<string, string>, decide: { real: VerdictModule; copies: Record<string, VerdictModule> } | null, pick?: { attack: string; copy: string }): string {
  const html = renderToStaticMarkup(createElement(BreakView, { data: m, kani, modules: decide, initial: pick }));
  return html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('the rendered page carries the coverage text word for word, labels constructed cases and passes the banned phrase list', async () => {
  const m = manifest();
  const kani = Object.fromEntries(m.copies.map((c) => [c.id, readFileSync(join(mutants, c.kani), 'utf8')]));
  const copies: Record<string, VerdictModule> = {};
  for (const c of m.copies) copies[c.id] = await copyWasm(c.id);
  const banned = read('docs/banned-phrases.txt')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('README-only:'))
    .map((l) => new RegExp(l, 'i'));
  for (const c of m.copies) {
    const t = renderedText(m, kani, { real: await realWasm(), copies }, { attack: c.attack, copy: c.id });
    const flat = t.replace(/\s+/g, ' ');
    assert.ok(flat.includes(COVERAGE), 'the coverage text is not on the page word for word');
    assert.equal(COVERAGE, 'The Lean theorems are proved about a model of the gate written in Lean from the Rust function; they do not read the Rust. Two checks tie the model to the code: Kani checks the same properties on the Rust function itself for every input its harness allows, and a test runs the Lean model and the Rust function on 2,000 fixed cases and compares every answer. None of this covers the rest of the contract: storage, the address book proofs, the ledgers\' bookkeeping, signatures, the agent, the model or the chain.');
    assert.ok(flat.includes('Break the proof'));
    assert.ok(flat.includes('The real gate refuses. The broken copy pays.'), `${c.id}: the result line is missing`);
    assert.ok(flat.includes(c.harness.name) && flat.includes(`${c.harness.file}:${String(c.harness.line)}`), `${c.id}: harness not shown`);
    assert.ok(flat.includes(c.lean.name) && flat.includes(`${c.lean.file}:${String(c.lean.line)}`), `${c.id}: theorem not shown`);
    assert.ok(flat.includes('Status: FAILURE'), `${c.id}: the recorded failure is not shown`);
    const a = m.attacks.find((x) => x.id === c.attack);
    if (a?.constructed === true) assert.ok(flat.includes('constructed case'), `${c.id}: a constructed attack is not labelled`);
    for (const re of [...banned, ...BRIEF_BANNED]) assert.ok(!re.test(flat), `${c.id}: banned ${String(re)}`);
    assert.ok(!flat.includes(String.fromCharCode(0x2014)) && !flat.includes(String.fromCharCode(0x2013)) && !flat.includes('--'), `${c.id}: a dash in the copy`);
  }
  // before the modules load the page still renders its text, and says it is loading
  const t = renderedText(m, kani, null).replace(/\s+/g, ' ');
  assert.ok(t.includes(COVERAGE));
});

// visitor test 2026-11-11: picking an attack kept the previous copy, so both machines said Refused. The page now selects the copy that pays the
// attack, found by running every copy on it; this pins that the computed copy is the one the manifest pairs with each attack.
test('picking an attack selects the copy that pays it, computed by running the copies, and the intro is true at every width', async () => {
  const m = manifest();
  const copies: Record<string, VerdictModule> = {};
  for (const c of m.copies) copies[c.id] = await copyWasm(c.id);
  const gates = { real: await realWasm(), copies };
  for (const a of m.attacks) {
    const c = payingCopy(m, a, gates);
    assert.equal(c?.id, m.copies.find((x) => x.attack === a.id)?.id, a.id);
    assert.equal(payingCopy(m, a, null)?.id, c?.id, `${a.id}: before the gates load the manifest pair is used`);
    if (c !== undefined) assert.equal(resultOf(a, gates.real.decide(a.columns.map(BigInt)), copies[c.id]?.decide(a.columns.map(BigInt)) ?? { kind: 'malformed' }).line, 'The real gate refuses. The broken copy pays.');
  }
  const t = renderedText(m, {}, gates).replace(/\s+/g, ' ');
  assert.ok(!t.includes('on the right'), 'a phone shows the copies below, so the intro names no side');
  assert.ok(t.indexOf('our model checker (Kani)') >= 0 || t.indexOf('model checker (Kani)') >= 0, 'plain words before Kani');
  assert.ok(t.indexOf('model checker (Kani)') < t.indexOf('Kani ') || !t.includes('Kani '), 'the first Kani is introduced');
  assert.ok(t.includes('machine-checked proof (Lean)'));
});

test('the /break route is a lazy route listed in the static site', () => {
  assert.equal(typeof ROUTES['/break'], 'function');
  assert.ok(PAGES.some((p) => p.path === '/break' && p.alias === undefined));
  assert.ok((STATIC_ROUTES as readonly string[]).includes('break'));
  assert.ok(/lazy\(\(\) => import\('\.\/break\/BreakPage\.tsx'\)\)/.test(readFileSync(join(web, 'src', 'routes.ts'), 'utf8')));
});

test('the committed copies are byte for byte a fresh build', { timeout: 900_000 }, (t) => {
  if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('needs cargo');
  const r = spawnSync('bash', ['scripts/build-verdict-mutants.sh', '--check'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /VERDICT MUTANTS OK \d+/);
});

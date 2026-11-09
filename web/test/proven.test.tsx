// AIR-302: docs/proven.json is the one source of the proven list. docs/PROVEN.md, the /proven console page and the `pnpm proven` lines must all
// come from it, every name in it must resolve, and every Kani harness of the verdict crate must be listed once (so the page cannot quietly omit one).
import assert from 'node:assert/strict';
import { plain } from '../src/components/plain.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProvenPage } from '../src/proven/ProvenPage.tsx';
import { ROUTES } from '../src/routes.ts';
import { DOC_PATH, ROOT, evaluate, loadSource, parseKaniLog, renderMarkdown, summary, validateNames } from '../../scripts/proven-lib.ts';
import type { Results } from '../../scripts/proven-lib.ts';

const src = loadSource();

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('proven: docs/PROVEN.md is exactly what docs/proven.json renders', () => {
  assert.equal(fs.readFileSync(DOC_PATH, 'utf8'), renderMarkdown(src));
});

test('proven: every name in the source resolves (theorem, harness, claim row, file)', () => {
  assert.deepEqual(validateNames(src), []);
});

test('proven: the console page lists every entry, in order, with its sentence and every proof name', () => {
  const html = renderToStaticMarkup(<ProvenPage />);
  assert.deepEqual([...html.matchAll(/data-testid="proven-entry-([^"]+)"/g)].map((m) => m[1]), src.entries.map((e) => e.id));
  const body = text(html);
  for (const e of src.entries) {
    assert.ok(body.includes(plain(e.says)), e.id + ' sentence');
    assert.ok(body.includes(plain(e.notCovered)), e.id + ' not covered');
    for (const p of e.proofs) assert.ok(body.includes(p.name), e.id + ' ' + p.name);
  }
  for (const n of src.notCovered) assert.ok(body.includes(plain(n)));
  assert.ok(body.includes('PROVEN OK ' + src.entries.length + ' of ' + src.entries.length));
});

test('proven: `pnpm proven --list` prints the same ids as the source and the page', () => {
  const r = spawnSync('pnpm', ['exec', 'tsx', 'scripts/proven.ts', '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), src.entries.map((e) => e.id));
});

test('proven: every Kani harness is listed exactly once, and a Lean theorem of Verdict.lean is listed for each pinned theorem', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'contracts/airlock-verdict/harnesses.toml'), 'utf8');
  const all = [...toml.matchAll(/^name = "([^"]+)"/gm)].map((m) => m[1] as string).sort();
  const listed = src.entries.flatMap((e) => e.proofs.filter((p) => p.kind === 'kani').map((p) => p.name)).sort();
  assert.deepEqual(listed, all);
  const pinned = (JSON.parse(fs.readFileSync(path.join(ROOT, 'proofs/comparator.json'), 'utf8')) as { theorem_names: string[] }).theorem_names;
  const lean = new Set(src.entries.flatMap((e) => e.proofs.filter((p) => p.kind === 'lean').map((p) => p.name)));
  for (const t of pinned) assert.ok(lean.has(t), 'pinned theorem not listed: ' + t);
});

test('proven: the route /proven is registered', () => {
  assert.equal(typeof ROUTES['/proven'], 'function');
});

function allOk(): Results {
  const kani = new Map<string, string>();
  for (const e of src.entries) for (const p of e.proofs) if (p.kind === 'kani') kani.set(p.name, 'SUCCESSFUL');
  return { leanOk: true, kani, diffOk: true };
}

test('proven: all three runs green gives one PROVEN line per entry and PROVEN OK n of n', () => {
  const lines = evaluate(src, allOk());
  assert.equal(lines.length, src.entries.length);
  assert.ok(lines.every((l) => l.ok && l.text.startsWith('PROVEN ')));
  assert.equal(summary(lines), 'PROVEN OK ' + src.entries.length + ' of ' + src.entries.length);
});

test('proven: a harness that did not run, a failed harness, a failed Lean check and a failed differential test each fail their entries', () => {
  const missing = allOk();
  missing.kani.delete('p01_untrusted_pc_never_allowed');
  const a = evaluate(src, missing);
  assert.deepEqual(a.filter((l) => !l.ok).map((l) => l.id), ['control-flow-trusted']);
  assert.match(summary(a), /^PROVEN FAILED 1 of /);

  const failed = allOk();
  failed.kani.set('p08_total', 'FAILED');
  assert.deepEqual(evaluate(src, failed).filter((l) => !l.ok).map((l) => l.id), ['total']);

  const noLean = evaluate(src, { ...allOk(), leanOk: false });
  const leanIds = src.entries.filter((e) => e.proofs.some((p) => p.kind === 'lean')).map((e) => e.id);
  assert.deepEqual(noLean.filter((l) => !l.ok).map((l) => l.id), leanIds);

  assert.deepEqual(evaluate(src, { ...allOk(), diffOk: false }).filter((l) => !l.ok).map((l) => l.id), ['lean-matches-rust']);
});

test('proven: the Kani log reader takes the verdict of each harness block, should_panic harnesses included', () => {
  const log = [
    'Checking harness verdict::p08_total...',
    'VERIFICATION:- SUCCESSFUL',
    'Checking harness verdict::l6a_x...',
    'VERIFICATION:- SUCCESSFUL (encountered one or more panics as expected)',
    'Checking harness verdict::bad...',
    'VERIFICATION:- FAILED',
  ].join('\n');
  assert.deepEqual([...parseKaniLog(log)], [['p08_total', 'SUCCESSFUL'], ['l6a_x', 'SUCCESSFUL'], ['bad', 'FAILED']]);
});

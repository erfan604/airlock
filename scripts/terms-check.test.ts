// AIR-362: the term sheet check. The real source passes; a wrong line, a missing status, a limit without a sentence, a short transaction
// hash, an EVIDENCE row that does not hold its transaction and the banned wording each fail; docs/TERMS.md is exactly what the source renders;
// the command ends with `TERMS OK <n> covenants`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DOC, ROOT, checkTerms, clauses, loadTerms, renderMarkdown } from './terms-lib.ts';
import type { Ref, Terms } from './terms-lib.ts';

const fresh = (): Terms => loadTerms();
const firstFileRef = (t: Terms): Extract<Ref, { line: number }> => {
  for (const c of clauses(t)) for (const r of c.refs) if (!('tx' in r)) return r;
  throw new Error('no file reference');
};

test('the source passes every check and has at least 19 covenants', () => {
  const t = fresh();
  assert.deepEqual(checkTerms(t), []);
  assert.ok(clauses(t).length >= 19);
  assert.ok(clauses(t).some((c) => c.kind === 'limit') && clauses(t).some((c) => c.kind === 'term'));
});

test('a wrong line fails', () => {
  const t = fresh();
  const r = firstFileRef(t);
  r.line += 1;
  if (r.to !== undefined) r.to = r.line;
  const errs = checkTerms(t);
  assert.ok(errs.some((e) => e.includes('does not contain')), errs.join('\n'));
});

test('a missing status fails', () => {
  const t = fresh();
  (clauses(t)[0] as { status?: string }).status = undefined;
  assert.ok(checkTerms(t).some((e) => e.includes('status')));
});

test('a limit without a sentence fails', () => {
  const t = fresh();
  const limit = clauses(t).find((c) => c.kind === 'limit');
  assert.ok(limit !== undefined);
  limit.text = '';
  assert.ok(checkTerms(t).some((e) => e.includes('has no sentence')));
});

test('a short transaction hash and an EVIDENCE row without its transaction fail', () => {
  const t = fresh();
  const shown = clauses(t)
    .flatMap((c) => c.refs)
    .filter((r): r is Extract<Ref, { tx: string }> => 'tx' in r && r.row !== undefined);
  assert.ok(shown.length >= 2);
  (shown[0] as { tx: string }).tx = 'BNq34she';
  (shown[1] as { row?: number }).row = 1;
  const errs = checkTerms(t);
  assert.ok(errs.some((e) => e.includes('is not a full hash')));
  assert.ok(errs.some((e) => e.includes('does not hold transaction')));
});

test('banned wording, the word testnet and "test network" outside its clause fail', () => {
  for (const [text, want] of [
    ['The pool is risk-free for lenders.', 'risk-free'],
    ['Lenders are insured by the pool.', 'insured'],
    ['The only way money leaves is a payment.', 'only'],
    ['This is the first pool of its kind.', 'first'],
    ['It runs on testnet for now.', 'testnet'],
    ['It runs on the test network for now.', 'test network'],
  ] as const) {
    const t = fresh();
    const c = clauses(t).find((x) => x.network !== true);
    assert.ok(c !== undefined);
    c.text = text;
    assert.ok(checkTerms(t).some((e) => e.includes(want)), `${text} passed`);
  }
});

test('docs/TERMS.md is exactly what docs/terms.json renders', () => {
  assert.equal(readFileSync(join(ROOT, DOC), 'utf8'), renderMarkdown(fresh()));
});

test('the command ends with TERMS OK and the number of covenants', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/terms-check.ts'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout.trim().split('\n').at(-1) ?? '', new RegExp(`^TERMS OK ${String(clauses(fresh()).length)} covenants$`));
});

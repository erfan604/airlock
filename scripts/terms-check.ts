// AIR-362: checks the term sheet. Every cited file:line of docs/terms.json still contains its named symbol, test or theorem; every EVIDENCE
// row cited still holds its transaction; every transaction hash is full length; every clause has a sentence and a status; the wording rules
// hold; and docs/TERMS.md is what the source renders. `--write` rewrites docs/TERMS.md first.
// Run: pnpm tsx scripts/terms-check.ts [--write]. Last line `TERMS OK <n> covenants`, or `TERMS FAILED (<k> problems)` and exit 1.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOC, ROOT, checkTerms, clauses, loadTerms, renderMarkdown } from './terms-lib.ts';

const t = loadTerms();
const md = renderMarkdown(t);
if (process.argv.includes('--write')) writeFileSync(join(ROOT, DOC), md);
const problems = checkTerms(t);
let doc = '';
try {
  doc = readFileSync(join(ROOT, DOC), 'utf8');
} catch {
  doc = '';
}
if (doc !== md) problems.push(`${DOC} is not what docs/terms.json renders (run scripts/terms-check.ts --write)`);
for (const p of problems) console.log(p);
if (problems.length > 0) {
  console.log(`TERMS FAILED (${String(problems.length)} problems)`);
  process.exit(1);
}
console.log(`TERMS OK ${String(clauses(t).length)} covenants`);

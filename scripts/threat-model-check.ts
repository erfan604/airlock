// AIR-242: checks docs/THREAT_MODEL.md against the bench cases.
// Usage: node scripts/threat-model-check.ts [--root <repo root>]   (pnpm tsx works too; erasable TypeScript, standard library only)
// Checks: the title and the seven headings in order; the AIR-084 trusted renderer sentence byte for byte; every
// own-<Group><nn>... token is the id of a case in bench/cases/*.jsonl; at least one case id of each run group A, B, C, S, X
// and P is named; every id of bench/cases/not-run.json is named; no placeholder text and no word judge.
// Prints each finding as FINDING <text> and exits 1, or prints THREAT MODEL OK <n> case ids and exits 0 (2 on a missing input).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADINGS = [
  '## Assets',
  '## Adversary (capabilities, and what they cannot do)',
  '## Trust boundaries and what happens if each fails',
  '## Trusted renderer (R4-04)',
  '## Attack groups covered (A to H) with the bench case ids',
  '## Assumptions',
  '## Out of scope',
];
const SENTENCE = "The trusted renderer is the owner's wallet, not the AIRLOCK console, which may share a host with the agent.";
const RUN_GROUPS = ['A', 'B', 'C', 'S', 'X', 'P'];
const PLACEHOLDERS = [/To fill during the build/i, /Skeleton written before the event/i];
const OWN_ID = /own-[A-Z][0-9]{2}[A-Za-z0-9-]*/g;

const args = process.argv.slice(2);
const at = args.indexOf('--root');
const root = at >= 0 && args[at + 1] ? args[at + 1] as string : join(dirname(fileURLToPath(import.meta.url)), '..');

function readOrExit(path: string): string {
  if (!existsSync(path)) { console.log('INPUT MISSING ' + path); process.exit(2); }
  return readFileSync(path, 'utf8');
}

const text = readOrExit(join(root, 'docs', 'THREAT_MODEL.md'));
const casesDir = join(root, 'bench', 'cases');
if (!existsSync(casesDir)) { console.log('INPUT MISSING ' + casesDir); process.exit(2); }
const groupOf = new Map<string, string>();
for (const name of readdirSync(casesDir).filter((n) => n.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(casesDir, name), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as { id?: unknown; group?: unknown };
    if (typeof c.id === 'string') groupOf.set(c.id, typeof c.group === 'string' ? c.group : '');
  }
}
const notRun = JSON.parse(readOrExit(join(casesDir, 'not-run.json'))) as { id?: unknown }[];

const findings: string[] = [];
const lines = text.split('\n');
if (!/^# \S/.test(lines.find((l) => l.trim() !== '') ?? '')) findings.push('the first line is not a # title');
let last = -1;
for (const h of HEADINGS) {
  const i = lines.indexOf(h);
  if (i < 0) findings.push('missing heading ' + h);
  else if (i < last) findings.push('heading out of order: ' + h);
  else last = i;
}
if (!text.includes(SENTENCE)) findings.push('the AIR-084 trusted renderer sentence is missing or changed');
const named = new Set<string>();
for (const m of text.matchAll(OWN_ID)) {
  const id = m[0].replace(/-+$/, '');
  if (!groupOf.has(id)) findings.push('unknown case id ' + id + ' (not an id in bench/cases/*.jsonl)');
  else named.add(id);
}
for (const g of RUN_GROUPS) {
  if (![...named].some((id) => groupOf.get(id) === g)) findings.push('no case id of group ' + g);
}
for (const row of notRun) {
  const id = typeof row.id === 'string' ? row.id : '';
  const re = new RegExp('(?<![A-Za-z0-9-])' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])');
  if (!id || !re.test(text)) findings.push('not-run id ' + (id || '(empty)') + ' is not named');
}
for (const re of PLACEHOLDERS) if (re.test(text)) findings.push('placeholder text: ' + re.source);
if (/\bjudges?\b/i.test(text)) findings.push('the word judge appears');

if (findings.length) {
  for (const f of findings) console.log('FINDING ' + f);
  process.exit(1);
}
console.log('THREAT MODEL OK ' + named.size + ' case ids');

// AIR-241: checks docs/KNOWN_LIMITATIONS.md. Usage: node scripts/limits-check.ts [--root <repo root>] (pnpm tsx works too)
// Fails unless the file has at least 30 lines starting "- " (29 when docs/DECISIONS.md has a line "G4 <date> OUT", because the
// dcap-qvl bullet is deleted then), every keyword below occurs case-insensitively, and no line holds a placeholder or the
// word judge. Prints FINDING lines and exits 1, or LIMITS OK <n> bullets and exits 0 (2 when the file is missing).
// Erasable TypeScript, standard library only.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYWORDS = [
  // the fifteen of the skeleton
  'host powers', 'unattested', 'oracle dust', 'plan_hash', 'UTC', 'socially engineered', 'side channel', 'K2', 'quick cap',
  'trusted computing base', 'fixtures', 'testnet only', 'cancel', 'owner transfer', 'Lean',
  // the nine this ticket adds
  'payment before delivery', 'availability', 'pairing', 'x402', 'look-alike', 'Ed25519', 'reject-all', 'careless owner', 'simulated',
];
const PLACEHOLDERS = [/To fill during the build/i, /Skeleton written before the event/i];

const args = process.argv.slice(2);
const at = args.indexOf('--root');
const root = at >= 0 && args[at + 1] ? args[at + 1] as string : join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'docs', 'KNOWN_LIMITATIONS.md');
if (!existsSync(path)) { console.log('INPUT MISSING ' + path); process.exit(2); }
const text = readFileSync(path, 'utf8');
const decisions = join(root, 'docs', 'DECISIONS.md');
const g4Out = existsSync(decisions) && /^G4 \S+ OUT\b/m.test(readFileSync(decisions, 'utf8'));
const minimum = g4Out ? 29 : 30;

const findings: string[] = [];
const lines = text.split('\n');
const bullets = lines.filter((l) => l.startsWith('- ')).length;
if (bullets < minimum) findings.push(`${bullets} bullets, at least ${minimum} needed${g4Out ? ' (G4 OUT)' : ''}`);
const lower = text.toLowerCase();
for (const k of KEYWORDS) if (!lower.includes(k.toLowerCase())) findings.push('keyword missing: ' + k);
lines.forEach((l, i) => {
  if (PLACEHOLDERS.some((re) => re.test(l))) findings.push(`line ${i + 1}: placeholder text`);
  if (/\bjudges?\b/i.test(l)) findings.push(`line ${i + 1}: the word judge`);
});

if (findings.length) {
  for (const f of findings) console.log('FINDING ' + f);
  process.exit(1);
}
console.log(`LIMITS OK ${bullets} bullets`);

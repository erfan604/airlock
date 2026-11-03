// AIR-302: `pnpm proven`. Runs the three real checks and prints one line per entry of docs/proven.json, then `PROVEN OK <n> of <n>`.
//   (no flag)    prints the time estimate, runs scripts/lean-axioms.sh, scripts/kani-check.sh and scripts/diff-verdict.sh --commit,
//                prints one line per entry and the last line; exit 0 only when every entry is proven
//   --list       prints the entry ids, one per line, without running anything (the test reads this)
//   --write-doc  rewrites docs/PROVEN.md from docs/proven.json
//   --check-doc  exits 1 when docs/PROVEN.md differs from what docs/proven.json renders, or a name in the source does not resolve
// An entry is proven only when every Lean theorem, Kani harness and test it names ran and passed: a harness that did not run is a failure,
// never a silent pass.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DOC_PATH, ROOT, evaluate, loadSource, parseKaniLog, renderMarkdown, summary, validateNames } from './proven-lib.ts';

const src = loadSource();
const flag = process.argv[2];

if (flag === '--list') {
  for (const e of src.entries) console.log(e.id);
  process.exit(0);
}
if (flag === '--write-doc') {
  fs.writeFileSync(DOC_PATH, renderMarkdown(src));
  console.log('wrote docs/PROVEN.md');
  process.exit(0);
}
const bad = validateNames(src);
if (flag === '--check-doc') {
  for (const b of bad) console.log('UNRESOLVED ' + b);
  const same = fs.existsSync(DOC_PATH) && fs.readFileSync(DOC_PATH, 'utf8') === renderMarkdown(src);
  if (!same) console.log('docs/PROVEN.md differs from docs/proven.json: run pnpm tsx scripts/proven.ts --write-doc');
  process.exit(bad.length === 0 && same ? 0 : 1);
}
if (flag !== undefined) {
  console.error('usage: pnpm proven [--list | --write-doc | --check-doc]');
  process.exit(2);
}
if (bad.length) {
  for (const b of bad) console.log('UNRESOLVED ' + b);
  console.log('PROVEN FAILED: docs/proven.json names something that does not exist');
  process.exit(1);
}

function step(label: string, cmd: string, args: string[], log: string): { ok: boolean; out: string } {
  const t0 = Date.now();
  process.stdout.write(label + ' ... ');
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  fs.mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'target', log), out);
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log((r.status === 0 ? 'ok' : 'FAILED (exit ' + r.status + ', see target/' + log + ')') + ' in ' + secs + ' s');
  return { ok: r.status === 0, out };
}

console.log('pnpm proven: about ' + src.estimateMinutes + ' minutes (Lean build and axiom audit, ' + 'every Kani harness, 40,000 differential cases). Logs go to target/.');
const lean = step('Lean theorems and axiom audit', 'scripts/lean-axioms.sh', [], 'proven-lean.log');
const leanOk = lean.ok && lean.out.includes('AXIOMS OK:') && lean.out.includes('LEANCHECKER OK');
const kani = step('Kani harnesses', 'scripts/kani-check.sh', [], 'proven-kani.log');
const kaniLog = path.join(ROOT, 'target', 'kani.log');
const kaniMap = kani.ok && kani.out.includes('KANI OK:') && fs.existsSync(kaniLog) ? parseKaniLog(fs.readFileSync(kaniLog, 'utf8')) : new Map<string, string>();
const diff = step('Differential test, Lean against Rust', 'scripts/diff-verdict.sh', ['--commit'], 'proven-diff.log');
const diffOk = diff.ok && diff.out.includes('identical on 40000 cases');

console.log('');
const lines = evaluate(src, { leanOk, kani: kaniMap, diffOk });
for (const l of lines) console.log(l.text);
console.log(summary(lines));
process.exit(lines.every((l) => l.ok) ? 0 : 1);

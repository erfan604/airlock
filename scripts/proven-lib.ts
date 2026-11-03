// AIR-302: the one source of the "what is proven" list is docs/proven.json. This file reads it, renders docs/PROVEN.md from it, checks that
// every name in it exists (a Lean theorem in its file, a Kani harness in harnesses.toml, a claim row in docs/CLAIMS.md), and turns the results
// of the three real runs (lean-axioms.sh, kani-check.sh, diff-verdict.sh --commit) into one line per entry. The console page reads the same JSON.
// Erasable TypeScript, standard library only.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Proof = { kind: 'lean' | 'kani' | 'diff'; name: string; file?: string };
export type Entry = { id: string; says: string; notCovered: string; bound: string; files: string[]; claims: string[]; proofs: Proof[] };
export type Source = { title: string; lead: string; command: string; estimateMinutes: number; notCovered: string[]; entries: Entry[] };

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_PATH = path.join(ROOT, 'docs', 'proven.json');
export const DOC_PATH = path.join(ROOT, 'docs', 'PROVEN.md');
export const DEFAULT_LEAN_FILE = 'proofs/Verdict.lean';

export function loadSource(file = SOURCE_PATH): Source {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Source;
}

function ticks(names: string[]): string {
  return names.map((n) => '`' + n + '`').join(', ');
}

/** The Markdown of docs/PROVEN.md, byte for byte. */
export function renderMarkdown(src: Source): string {
  const out: string[] = [];
  out.push('# ' + src.title, '');
  out.push('Generated from docs/proven.json by `pnpm tsx scripts/proven.ts --write-doc`; do not edit by hand. The console shows the same list at `/proven`.', '');
  out.push(src.lead, '');
  out.push('Recheck all of it with one command: `' + src.command + '` (about ' + src.estimateMinutes + ' minutes on an Apple Silicon Mac). It runs the Lean build and axiom audit, every Kani harness and the 40,000 case differential test, prints one line per entry below, and ends with `PROVEN OK ' + src.entries.length + ' of ' + src.entries.length + '`.', '');
  out.push('## What this does not cover', '');
  for (const n of src.notCovered) out.push('- ' + n);
  out.push('');
  out.push('## What is proven', '');
  src.entries.forEach((e, i) => {
    out.push('### ' + (i + 1) + '. ' + e.says, '');
    const lean = e.proofs.filter((p) => p.kind === 'lean').map((p) => p.name);
    const kani = e.proofs.filter((p) => p.kind === 'kani').map((p) => p.name);
    const diff = e.proofs.filter((p) => p.kind === 'diff').map((p) => p.name);
    if (lean.length) out.push('- Lean theorems: ' + ticks(lean));
    if (kani.length) out.push('- Kani harnesses: ' + ticks(kani));
    if (diff.length) out.push('- Differential test: `' + diff.join('`, `') + '`');
    out.push('- Bound: ' + e.bound);
    out.push('- Not covered: ' + e.notCovered);
    out.push('- Files: ' + ticks(e.files));
    out.push('- Claims: ' + e.claims.map((c) => '[' + c + ']').join(' '));
    out.push('');
  });
  return out.join('\n');
}

/** Names that do not resolve: a Lean theorem missing from its file, a Kani harness missing from the toml, a claim id missing from CLAIMS.md, a missing file. */
export function validateNames(src: Source, root = ROOT): string[] {
  const bad: string[] = [];
  const toml = fs.readFileSync(path.join(root, 'contracts/airlock-verdict/harnesses.toml'), 'utf8');
  const harnesses = new Set([...toml.matchAll(/^name = "([^"]+)"/gm)].map((m) => m[1] as string));
  const claims = fs.readFileSync(path.join(root, 'docs/CLAIMS.md'), 'utf8');
  const ids = new Set<string>();
  for (const e of src.entries) {
    if (ids.has(e.id)) bad.push('duplicate id ' + e.id);
    ids.add(e.id);
    for (const f of e.files) if (!fs.existsSync(path.join(root, f))) bad.push(e.id + ': missing file ' + f);
    for (const c of e.claims) if (!new RegExp('^\\| ' + c + ' \\|', 'm').test(claims)) bad.push(e.id + ': no claim row ' + c);
    for (const p of e.proofs) {
      if (p.kind === 'kani' && !harnesses.has(p.name)) bad.push(e.id + ': no Kani harness ' + p.name);
      if (p.kind === 'lean') {
        const file = path.join(root, p.file ?? DEFAULT_LEAN_FILE);
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (!new RegExp('^theorem ' + p.name + '(\\s|$)', 'm').test(text)) bad.push(e.id + ': no Lean theorem ' + p.name + ' in ' + (p.file ?? DEFAULT_LEAN_FILE));
      }
    }
  }
  return bad;
}

/** What the three runs showed. kani maps a harness name to the verdict line of its block. */
export type Results = { leanOk: boolean; kani: Map<string, string>; diffOk: boolean };

/** Reads a `cargo kani` log: the VERIFICATION line of every `Checking harness` block (should_panic harnesses read `SUCCESSFUL (encountered one or more panics as expected)`). */
export function parseKaniLog(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^Checking harness (\S+)\.\.\.$/.exec(line);
    if (m) {
      cur = (m[1] as string).split('::').pop() as string;
      continue;
    }
    const v = /^VERIFICATION:- (SUCCESSFUL|FAILED)/.exec(line);
    if (v && cur) {
      out.set(cur, v[1] as string);
      cur = null;
    }
  }
  return out;
}

export type Line = { id: string; ok: boolean; text: string };

/** One line per entry: PROVEN <id> (what ran) or FAILED <id> (what did not). */
export function evaluate(src: Source, r: Results): Line[] {
  return src.entries.map((e) => {
    const problems: string[] = [];
    const lean = e.proofs.filter((p) => p.kind === 'lean');
    const kani = e.proofs.filter((p) => p.kind === 'kani');
    const diff = e.proofs.filter((p) => p.kind === 'diff');
    if (lean.length && !r.leanOk) problems.push('Lean check failed');
    for (const p of kani) if (r.kani.get(p.name) !== 'SUCCESSFUL') problems.push('Kani ' + p.name + ' ' + (r.kani.get(p.name) ?? 'did not run'));
    if (diff.length && !r.diffOk) problems.push('differential test failed');
    const parts: string[] = [];
    if (lean.length) parts.push('lean ' + lean.length);
    if (kani.length) parts.push('kani ' + kani.length);
    if (diff.length) parts.push('diff 40000');
    return problems.length === 0
      ? { id: e.id, ok: true, text: 'PROVEN ' + e.id.padEnd(26) + parts.join(', ') }
      : { id: e.id, ok: false, text: 'FAILED ' + e.id.padEnd(26) + problems.join('; ') };
  });
}

export function summary(lines: Line[]): string {
  const ok = lines.filter((l) => l.ok).length;
  return ok === lines.length ? 'PROVEN OK ' + ok + ' of ' + lines.length : 'PROVEN FAILED ' + (lines.length - ok) + ' of ' + lines.length;
}

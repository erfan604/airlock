// Claims lint (AIR-276). Enforces the say and do-not-say lines on the README and on any single doc.
//
// Usage: node scripts/claims-lint.ts [--readme <path>] [--docs <dir>] [--check-evidence] [--root <dir>] [--final]
//        node scripts/claims-lint.ts --file <path> [--lines-with <regex>] [--docs <dir>] [--markers <file>] [--final]
//   --readme   README to lint, default README.md
//   --docs     docs folder, default docs (CLAIMS, SOURCES, PRIOR_ART, BENCH and EVIDENCE are read from it)
//   --file     lint one file with rules 3 to 7 only; --lines-with limits the rules to the lines that match the regex
//   --markers  payload marker file, default fixtures/payload-markers.txt
//   --final    pending items (rows, empty bench block, missing payload scan input) become findings; implies --check-evidence
//   --check-evidence  rule 12, README mode only (--file ignores it); --root is the folder its paths resolve against. Without --root
//              that is the folder that holds the docs folder (the repo root when --docs is docs), the file must then be tracked
//              (git ls-files) when that folder is inside a git work tree and only has to exist otherwise. With --root (a fixture)
//              the file only has to exist under it
//
// Run it as `pnpm tsx scripts/claims-lint.ts` in the product repo or as plain `node scripts/claims-lint.ts` on Node 24.
// Erasable TypeScript only, standard library only.
//
// Rules (README mode applies all of them to the README, and rules 3, 6 and 9 also to every *.md directly in the docs folder):
//   1 tags resolve ([C<n>], [S<n>], [PA<n>])      2 claim sentences end with a tag      3 banned phrases (docs/banned-phrases.txt)
//   4 attested or attestation needs a registration row in EVIDENCE.md                   5 every number is in a doc or the allowlist
//   6 no em dash, en dash or double hyphen in prose   7 no payload text   8 prior-art section   9 no placeholder
//   10 bench block lines and hashes are verbatim copies   11 pending rows (pending: AIR-<nnn> in the Command cell)
//   12 every path:line or path:line-line token of a CLAIMS Evidence cell names a tracked file and a line inside it, and a backticked
//      symbol written right after the token (optionally in parentheses) appears within 3 lines of the token (of the whole range for
//      the line-line form). Pending rows are not checked: their evidence lands with the ticket that fills the row
// Rule 1 also reads the Needs cell of every CLAIMS row: none, network, keys, or a comma separated list of node, rust, kani, lean.
// The word lists docs/claim-verbs.txt, docs/banned-phrases.txt and docs/numbers-allowlist.txt are read from the docs folder next
// to the scripts folder this file sits in, whatever --docs says.
//
// Output: FINDING <rule> <path>:<line> <text>, FINAL <reason>, INPUT MISSING <path>, then the last line
//   CLAIMS LINT OK | CLAIMS LINT OK (<n> pending) | CLAIMS LINT FAIL <k> findings.   Exit 0 clean, 1 findings, 2 input missing.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const EM_DASH = '\u2014';
const EN_DASH = '\u2013';
const FILLER = '\u0001';
const BENCH_START = '<!-- bench:start -->';
const BENCH_END = '<!-- bench:end -->';
const DOC_NAMES = ['BENCH.md', 'CLAIMS.md', 'EVIDENCE.md', 'SOURCES.md', 'PRIOR_ART.md'];
const PLACEHOLDERS = [/To fill during the build/i, /Skeleton written before the event/i];

const TAG_SRC = '\\[(?:C\\d+[a-z]?|S\\d+|PA\\d+)\\]';
const TAGS_AT_END = new RegExp('(?:' + TAG_SRC + '\\s*)+$');
const TAG_ANY = new RegExp(TAG_SRC, 'g');
const TAG_PARTS = /\[(C\d+[a-z]?|S\d+|PA\d+)\]/g;
const CODE_RE = /(`{1,3})[^\n]*?\1/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/g;
const NUM_RE = /(?<![\w.,])(\d+(?:[.,]\d+)*%?)(?!\w)/g;
const VERSION_RE = /(?<![\w.])v?\d+(?:\.\d+){2,}(?!\w)/g;
// an ISO date or date-time (2026-10-31, 2026-11-01T00:00Z) is a point in time, not a quantity the docs must back
const DATE_RE = /(?<![\w.-])\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?(?![\w-])/g;
// identifiers, not number claims: a digit run joined to a word by a hyphen (AIR-201, erfan-7116, UTC-7) and arXiv ids (2610.26438)
const IDENT_RE = /(?<![\w.])[A-Za-z][A-Za-z0-9]*-\d[\w.]*(?!\w)|(?<![\w.])\d{4}\.\d{4,5}(?:v\d+)?(?!\w|\.\d)/g;
const HEX64_RE = /\b[0-9a-fA-F]{64}\b/g;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g;

type Line = { n: number; raw: string; fence: boolean; vis: string };
type Block = { kind: 'para' | 'item' | 'row'; text: string; starts: number[]; nums: number[] };
type Args = { readme: string; docs: string; file: string | null; linesWith: RegExp | null; markers: string; final: boolean; checkEvidence: boolean; root: string | null };
type Banned = { src: string; line: number; readmeOnly: boolean };
type ClaimRow = { id: string; line: number; command: string; expected: string; pending: boolean; ticket: string; evidence: string };
type Findings = { rule: number; where: string; text: string };

const findings: Findings[] = [];
const finals: string[] = [];
const missing: string[] = [];
const finalPaths: string[] = [];
const pendingReasons: string[] = [];

const scriptDir = path.dirname(fs.realpathSync(process.argv[1] ?? '.'));
const listDir = path.join(scriptDir, '..', 'docs');
const scanScript = path.join(scriptDir, 'payload-scan.sh');

function shown(p: string): string {
  let cwd = process.cwd();
  try {
    cwd = fs.realpathSync(cwd);
  } catch {
    // keep the plain cwd
  }
  const rel = path.relative(cwd, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

function add(rule: number, label: string, line: number, text: string): void {
  findings.push({ rule, where: label + ':' + line, text: text.replace(/\s+/g, ' ').trim() });
}

function noteMissing(label: string): void {
  if (!missing.includes(label)) missing.push(label);
}

function readText(p: string): string | null {
  try {
    if (!fs.statSync(p).isFile()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- arguments ----------

function parseArgs(argv: string[]): Args | string {
  const a: Args = { readme: 'README.md', docs: 'docs', file: null, linesWith: null, markers: 'fixtures/payload-markers.txt', final: false, checkEvidence: false, root: null };
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i] ?? '';
    i++;
    if (flag === '--final') a.final = true;
    else if (flag === '--check-evidence') a.checkEvidence = true;
    else if (flag === '--readme' || flag === '--docs' || flag === '--file' || flag === '--markers' || flag === '--lines-with' || flag === '--root') {
      const v = argv[i];
      if (v === undefined) return flag + ' needs a value';
      i++;
      if (flag === '--readme') a.readme = v;
      else if (flag === '--docs') a.docs = v;
      else if (flag === '--file') a.file = v;
      else if (flag === '--markers') a.markers = v;
      else if (flag === '--root') a.root = v;
      else {
        try {
          a.linesWith = new RegExp(v);
        } catch {
          return 'invalid regex for --lines-with';
        }
      }
    } else return 'unknown argument ' + flag;
  }
  if (a.linesWith !== null && a.file === null) return '--lines-with needs --file';
  return a;
}

// ---------- reading a markdown text line by line ----------

// vis is the line with HTML comments removed; lines inside a fenced code block get fence true and an empty vis.
function scanLines(text: string): Line[] {
  const raws = text.split(/\r?\n/);
  const out: Line[] = [];
  let fenceMark: string | null = null;
  let inComment = false;
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i] ?? '';
    if (fenceMark !== null) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(raw);
      if (close !== null && (close[1] ?? '')[0] === fenceMark[0] && (close[1] ?? '').length >= fenceMark.length) fenceMark = null;
      out.push({ n: i + 1, raw, fence: true, vis: '' });
      continue;
    }
    if (!inComment) {
      const open = /^\s*(`{3,}|~{3,})/.exec(raw);
      if (open !== null) {
        fenceMark = open[1] ?? '```';
        out.push({ n: i + 1, raw, fence: true, vis: '' });
        continue;
      }
    }
    let rest = raw;
    let vis = '';
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end < 0) {
          rest = '';
        } else {
          rest = rest.slice(end + 3);
          inComment = false;
        }
      } else {
        const start = rest.indexOf('<!--');
        if (start < 0) {
          vis += rest;
          rest = '';
        } else {
          vis += rest.slice(0, start);
          rest = rest.slice(start + 4);
          inComment = true;
        }
      }
    }
    out.push({ n: i + 1, raw, fence: false, vis });
  }
  return out;
}

function maskInline(s: string, fill: string): string {
  return s.replace(CODE_RE, (m) => fill.repeat(m.length)).replace(URL_RE, (m) => fill.repeat(m.length));
}

function isDelimiter(s: string): boolean {
  return s.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
}

function isThematic(s: string): boolean {
  return /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(s);
}

function splitRow(s: string): string[] {
  let t = s.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

// A cell value: the pipes unescaped, one pair of backticks around the whole cell removed.
function cellValue(cell: string): string {
  let v = cell.replace(/\\\|/g, '|').trim();
  const m = /^(`+)([\s\S]*)\1$/.exec(v);
  if (m !== null) v = (m[2] ?? '').trim();
  return v;
}

type Table = { header: string[]; rows: { n: number; cells: string[] }[] };

function tablesOf(lines: Line[]): Table[] {
  const out: Table[] = [];
  let cur: Table | null = null;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i] as Line;
    const s = L.vis;
    if (L.fence || !/^\s*\|/.test(s)) {
      cur = null;
      continue;
    }
    if (cur === null) {
      const next = lines[i + 1];
      if (next !== undefined && !next.fence && isDelimiter(next.vis)) {
        cur = { header: splitRow(s), rows: [] };
        out.push(cur);
        i++;
      }
      continue;
    }
    cur.rows.push({ n: L.n, cells: splitRow(s) });
  }
  return out;
}

// ---------- whole-text matching that also sees a phrase wrapped over two lines ----------

function matchAcross(texts: string[], re: RegExp): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (let i = 0; i < texts.length; i++) {
    const a = texts[i] ?? '';
    const b = texts[i + 1] ?? '';
    const joined = b.trim() === '' || a.trim() === '' ? a : a + ' ' + b;
    for (const m of joined.matchAll(g)) {
      if (m[0] === '') continue;
      if ((m.index ?? 0) < a.length) out.push({ index: i, text: m[0] });
    }
  }
  return out;
}

// ---------- block and sentence structure (rules 2 and 8) ----------

function blocksOf(lines: Line[], from: number, to: number, skip: (n: number) => boolean): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const flush = (): void => {
    if (cur !== null) blocks.push(cur);
    cur = null;
  };
  const addLine = (b: Block, text: string, n: number): void => {
    b.starts.push(b.text.length === 0 ? 0 : b.text.length + 1);
    b.nums.push(n);
    b.text = b.text.length === 0 ? text : b.text + '\n' + text;
  };
  for (let i = from; i < to; i++) {
    const L = lines[i] as Line;
    if (L.fence || skip(L.n)) {
      flush();
      continue;
    }
    const s = L.vis;
    if (s.trim() === '') {
      flush();
      continue;
    }
    if (/^\s{0,3}#{1,6}\s/.test(s) || isDelimiter(s) || isThematic(s)) {
      flush();
      continue;
    }
    const masked = maskInline(s, FILLER);
    if (/^\s*\|/.test(s)) {
      flush();
      const next = lines[i + 1];
      const isHeader = next !== undefined && i + 1 < to && !next.fence && isDelimiter(next.vis);
      if (!isHeader) {
        const b: Block = { kind: 'row', text: '', starts: [], nums: [] };
        addLine(b, masked, L.n);
        blocks.push(b);
      }
      continue;
    }
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(s);
    if (item !== null) {
      flush();
      cur = { kind: 'item', text: '', starts: [], nums: [] };
      addLine(cur, ' '.repeat(item[0].length) + masked.slice(item[0].length), L.n);
      continue;
    }
    const quote = /^\s*>\s?/.exec(masked);
    const body = quote !== null ? ' '.repeat(quote[0].length) + masked.slice(quote[0].length) : masked;
    if (cur === null) cur = { kind: 'para', text: '', starts: [], nums: [] };
    addLine(cur, body, L.n);
  }
  flush();
  return blocks;
}

function lineAt(b: Block, offset: number): number {
  let k = 0;
  for (let i = 0; i < b.starts.length; i++) if ((b.starts[i] ?? 0) <= offset) k = i;
  return b.nums[k] ?? b.nums[0] ?? 0;
}

function isAbbreviation(text: string, dot: number): boolean {
  return /(?:^|[\s(])(?:e\.g|i\.e|vs|cf)$/i.test(text.slice(Math.max(0, dot - 6), dot));
}

function sentencesOf(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '.' || c === '!' || c === '?') {
      let j = i;
      while (j + 1 < n && '.!?'.includes(text[j + 1] ?? '')) j++;
      let k = j + 1;
      while (k < n && '"\'\u201d\u2019)]'.includes(text[k] ?? '')) k++;
      const atEnd = k >= n || /\s/.test(text[k] ?? '');
      if (atEnd && !isAbbreviation(text, i)) {
        out.push({ start, end: i });
        start = k;
        i = k;
        continue;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  if (start < n) out.push({ start, end: n });
  return out;
}

function sectionOf(lines: Line[], headingTest: (h: string) => boolean): { from: number; to: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i] as Line;
    const m = L.fence ? null : /^##(?!#)\s+(.*?)\s*$/.exec(L.vis);
    if (m !== null && headingTest(m[1] ?? '')) {
      let to = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const M = lines[j] as Line;
        if (!M.fence && /^#{1,2}(?!#)\s/.test(M.vis)) {
          to = j;
          break;
        }
      }
      return { from: i + 1, to };
    }
  }
  return null;
}

// ---------- the bench block ----------

function benchInfo(lines: Line[]): { starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const L of lines) {
    if (L.fence) continue;
    const t = L.raw.trim();
    if (t === BENCH_START) starts.push(L.n);
    else if (t === BENCH_END) ends.push(L.n);
  }
  return { starts, ends };
}

// ---------- lists ----------

function readList(name: string): { line: number; text: string }[] | null {
  const p = path.join(listDir, name);
  const t = readText(p);
  if (t === null) {
    noteMissing(shown(p));
    return null;
  }
  const out: { line: number; text: string }[] = [];
  t.split(/\r?\n/).forEach((l, i) => {
    const s = l.trim();
    if (s !== '' && !s.startsWith('#')) out.push({ line: i + 1, text: s });
  });
  return out;
}

function readBanned(): Banned[] | null {
  const list = readList('banned-phrases.txt');
  if (list === null) return null;
  return list.map((e) => {
    const m = /^README-only:\s*(.*)$/.exec(e.text);
    return m !== null ? { src: m[1] ?? '', line: e.line, readmeOnly: true } : { src: e.text, line: e.line, readmeOnly: false };
  });
}

// ---------- rules on one text ----------

function rule3(label: string, lines: Line[], banned: Banned[], isReadme: boolean, keep: (n: number) => boolean): void {
  const texts = lines.map((L) => (keep(L.n) ? L.raw : ''));
  for (const b of banned) {
    if (b.readmeOnly && !isReadme) continue;
    let re: RegExp;
    try {
      re = new RegExp(b.src, 'ig');
    } catch {
      add(3, shown(path.join(listDir, 'banned-phrases.txt')), b.line, 'invalid regular expression in the banned list');
      continue;
    }
    for (const m of matchAcross(texts, re)) add(3, label, m.index + 1, 'banned phrase /' + b.src + '/ matches "' + m.text.trim() + '"');
  }
}

function rule6(label: string, lines: Line[], keep: (n: number) => boolean): void {
  for (const L of lines) {
    if (L.fence || !keep(L.n)) continue;
    if (isDelimiter(L.vis) || isThematic(L.vis)) continue;
    const t = maskInline(L.vis, ' ');
    if (t.includes(EM_DASH)) add(6, label, L.n, 'em dash in prose');
    else if (t.includes(EN_DASH)) add(6, label, L.n, 'en dash in prose');
    else if (t.includes('--')) add(6, label, L.n, 'double hyphen in prose');
  }
}

function rule9(label: string, lines: Line[]): void {
  const texts = lines.map((L) => L.raw);
  for (const re of PLACEHOLDERS) for (const m of matchAcross(texts, re)) add(9, label, m.index + 1, 'placeholder text "' + m.text + '"');
}

function numberTokens(lines: Line[], keep: (n: number) => boolean): { n: number; token: string }[] {
  const out: { n: number; token: string }[] = [];
  for (const L of lines) {
    if (L.fence || !keep(L.n)) continue;
    let s = maskInline(L.vis, ' ');
    s = s.replace(TAG_ANY, ' ');
    s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ' ');
    s = s.replace(DATE_RE, ' ');
    s = s.replace(VERSION_RE, ' ');
    s = s.replace(IDENT_RE, ' ');
    for (const m of s.matchAll(NUM_RE)) out.push({ n: L.n, token: m[1] ?? '' });
  }
  return out;
}

type DocCache = { texts: Map<string, string | null>; allowed: Set<string> | null; registered: boolean | null };

function docPath(docsArg: string, name: string): string {
  return docsArg.replace(/\/+$/, '') + '/' + name;
}

function loadDoc(cache: DocCache, docsArg: string, name: string): string | null {
  const p = docPath(docsArg, name);
  if (!cache.texts.has(p)) {
    const t = readText(p);
    cache.texts.set(p, t);
    if (t === null) noteMissing(p);
  }
  return cache.texts.get(p) ?? null;
}

function allowedNumbers(cache: DocCache, docsArg: string): Set<string> | null {
  if (cache.allowed !== null) return cache.allowed;
  const set = new Set<string>();
  let ok = true;
  for (const name of DOC_NAMES) {
    const t = loadDoc(cache, docsArg, name);
    if (t === null) {
      ok = false;
      continue;
    }
    for (const tok of numberTokens(scanLines(t), () => true)) set.add(tok.token);
  }
  const list = readList('numbers-allowlist.txt');
  if (list === null) ok = false;
  else for (const e of list) set.add(e.text.split(/\s+/)[0] ?? '');
  if (!ok) return null;
  cache.allowed = set;
  return set;
}

function rule5(label: string, lines: Line[], keep: (n: number) => boolean, cache: DocCache, docsArg: string): void {
  const tokens = numberTokens(lines, keep);
  if (tokens.length === 0) return;
  const allowed = allowedNumbers(cache, docsArg);
  if (allowed === null) return;
  const seen = new Set<string>();
  for (const t of tokens) {
    if (allowed.has(t.token) || seen.has(t.n + ':' + t.token)) continue;
    seen.add(t.n + ':' + t.token);
    add(5, label, t.n, 'number ' + t.token + ' is in none of BENCH, CLAIMS, EVIDENCE, SOURCES, PRIOR_ART or the numbers allowlist');
  }
}

function hasRegistrationRow(cache: DocCache, docsArg: string): boolean | null {
  if (cache.registered !== null) return cache.registered;
  const t = loadDoc(cache, docsArg, 'EVIDENCE.md');
  if (t === null) return null;
  cache.registered = t.split(/\r?\n/).some((l) => l.startsWith('| TEE registration tx') && l.includes('testnet.nearblocks.io/txns/'));
  return cache.registered;
}

function rule4(label: string, lines: Line[], keep: (n: number) => boolean, cache: DocCache, docsArg: string): void {
  const hits: { n: number; word: string }[] = [];
  for (const L of lines) {
    if (!keep(L.n)) continue;
    const s = maskInline(L.raw, ' ');
    for (const m of s.matchAll(/\battested\b/gi)) hits.push({ n: L.n, word: m[0] });
    const isQuoteLine = /^\s*>/.test(s);
    const unquoted = s.replace(/"[^"\n]*"/g, (m) => ' '.repeat(m.length)).replace(/\u201c[^\u201d\n]*\u201d/g, (m) => ' '.repeat(m.length));
    if (!isQuoteLine) for (const m of unquoted.matchAll(/\battestation\b/gi)) hits.push({ n: L.n, word: m[0] });
  }
  if (hits.length === 0) return;
  const registered = hasRegistrationRow(cache, docsArg);
  if (registered === null || registered) return;
  for (const h of hits) add(4, label, h.n, 'the word ' + h.word + ' needs a "TEE registration tx" row with a testnet.nearblocks.io/txns/ link in EVIDENCE.md');
}

// Rule 7 in file mode: a case-insensitive substring match of every non-empty marker, like grep -a -F -i -f.
function rule7File(label: string, lines: Line[], keep: (n: number) => boolean, markers: string[]): void {
  const low = markers.map((m) => m.toLowerCase());
  for (const L of lines) {
    if (!keep(L.n)) continue;
    const t = L.raw.toLowerCase();
    if (low.some((m) => t.includes(m))) add(7, label, L.n, 'line matches a payload marker');
  }
}

function readMarkers(p: string): string[] | null {
  const t = readText(p);
  if (t === null) return null;
  const list = t.split(/\r?\n/).filter((l) => l.trim() !== '');
  return list.length === 0 ? null : list;
}

// ---------- README mode: claims, sources, prior art ----------

// the Needs values of a CLAIMS row; the same reading as scripts/claims-run.ts
function validNeeds(v: string): boolean {
  if (v === 'none' || v === 'network' || v === 'keys') return true;
  return v.split(',').every((p) => ['node', 'rust', 'kani', 'lean'].includes(p.trim()));
}

function claimRows(lines: Line[], label: string): ClaimRow[] {
  const rows: ClaimRow[] = [];
  for (const t of tablesOf(lines)) {
    const h = t.header.map((c) => c.toLowerCase());
    let ci = h.indexOf('command');
    let ei = h.indexOf('expected output');
    let ni = h.indexOf('needs');
    let vi = h.findIndex((c) => c.startsWith('evidence'));
    if (ci < 0) ci = 3;
    if (ei < 0) ei = 4;
    if (ni < 0) ni = 5;
    if (vi < 0) vi = 2;
    for (const r of t.rows) {
      const id = r.cells[0] ?? '';
      if (!/^C\d+[a-z]?$/.test(id)) continue;
      const command = cellValue(r.cells[ci] ?? '');
      const expected = cellValue(r.cells[ei] ?? '');
      const needs = (r.cells[ni] ?? '').trim();
      if (!validNeeds(needs)) add(1, label, r.n, 'row ' + id + ' has Needs "' + needs + '", which is not none, network, keys or a comma separated list of node, rust, kani, lean');
      let pending = false;
      let ticket = '';
      if (command.startsWith('pending:')) {
        const m = /^pending: (AIR-\d+)(?:\s|$)/.exec(command);
        if (m === null) add(11, label, r.n, 'row ' + id + ' has "pending:" without a ticket id (write pending: AIR-<nnn> and then the command)');
        else {
          pending = true;
          ticket = m[1] ?? '';
        }
      }
      rows.push({ id, line: r.n, command, expected, pending, ticket, evidence: (r.cells[vi] ?? '').replace(/\\\|/g, '|') });
    }
  }
  return rows;
}

function ruleOne(label: string, lines: Line[], claims: ClaimRow[] | null, sources: Set<string> | null, priorArtRows: number | null): void {
  for (const L of lines) {
    if (L.fence) continue;
    const s = maskInline(L.vis, ' ');
    for (const m of s.matchAll(TAG_PARTS)) {
      const tag = m[1] ?? '';
      if (tag.startsWith('PA')) {
        if (priorArtRows === null) continue;
        const idx = Number(tag.slice(2));
        if (idx < 1 || idx > priorArtRows) add(1, label, L.n, 'prior-art tag [' + tag + '] is not a row of the first table of PRIOR_ART.md (it has ' + priorArtRows + ')');
      } else if (tag.startsWith('S')) {
        if (sources !== null && !sources.has(tag)) add(1, label, L.n, 'source tag [' + tag + '] is not a row of SOURCES.md');
      } else if (claims !== null) {
        const row = claims.find((r) => r.id === tag);
        if (row === undefined) add(1, label, L.n, 'claim tag [' + tag + '] is not a row of CLAIMS.md');
        else if (!row.pending && row.command === '') add(1, label, L.n, 'claim [' + tag + '] has an empty Command cell');
        else if (!row.pending && row.expected === '') add(1, label, L.n, 'claim [' + tag + '] has an empty Expected output cell');
      }
    }
  }
}

function ruleTwo(label: string, lines: Line[], verbs: RegExp[], benchSkip: (n: number) => boolean): void {
  const firstH2 = lines.findIndex((L) => !L.fence && /^##(?!#)\s/.test(L.vis));
  const title = lines.findIndex((L) => !L.fence && /^#(?!#)\s/.test(L.vis));
  const regions: { name: string; from: number; to: number }[] = [];
  regions.push({ name: 'intro', from: title >= 0 && (firstH2 < 0 || title < firstH2) ? title + 1 : 0, to: firstH2 < 0 ? lines.length : firstH2 });
  const wanted = ['the problem', 'what is enforced where', 'claims', 'results'];
  const found = new Set<string>();
  for (const w of wanted) {
    const sec = sectionOf(lines, (h) => h.toLowerCase().startsWith(w));
    if (sec !== null) {
      found.add(w);
      regions.push({ name: w, from: sec.from, to: sec.to });
    }
  }
  for (const w of ['the problem', 'what is enforced where', 'claims']) {
    if (!found.has(w)) add(2, label, 1, 'the README has no "## ' + w + '" section');
  }
  for (const r of regions) {
    for (const b of blocksOf(lines, r.from, r.to, benchSkip)) {
      if (b.kind === 'row') {
        const cells = splitRow(b.text).filter((c) => c !== '');
        const verb = verbs.find((v) => v.test(b.text));
        const last = cells[cells.length - 1] ?? '';
        if (verb !== undefined && !TAGS_AT_END.test(last)) {
          add(2, label, lineAt(b, 0), 'table row has a claim verb (' + verbName(verb) + ') but its last cell is not a tag: ' + excerpt(b.text));
        }
        continue;
      }
      for (const s of sentencesOf(b.text)) {
        const body = b.text.slice(s.start, s.end);
        if (body.trim() === '') continue;
        const verb = verbs.find((v) => v.test(body));
        if (verb !== undefined && !TAGS_AT_END.test(body.trimEnd())) {
          const first = s.start + (body.length - body.trimStart().length);
          add(2, label, lineAt(b, first), 'sentence has a claim verb (' + verbName(verb) + ') but does not end with a tag: ' + excerpt(body));
        }
      }
    }
  }
}

function verbName(re: RegExp): string {
  return re.source.replace(/^\\b|\\b$/g, '').replace(/\\/g, '');
}

function excerpt(s: string): string {
  const t = s.replace(/\s+/g, ' ').replace(new RegExp(FILLER, 'g'), '').trim();
  return t.length > 70 ? t.slice(0, 67) + '...' : t;
}

function ruleEight(label: string, lines: Line[]): void {
  const sec = sectionOf(lines, (h) => /prior[\s-]art/i.test(h));
  if (sec === null) {
    add(8, label, 1, 'the README has no prior-art section');
    return;
  }
  const raw = lines
    .slice(sec.from, sec.to)
    .map((L) => L.vis)
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const heading = sec.from;
  for (const need of ['interbolt', 'microsoft/agent-framework', 'pc taint', 'amount provenance', 'enforcement at the signer']) {
    if (!raw.includes(need)) add(8, label, heading, 'the prior-art section does not contain "' + need + '"');
  }
  for (const b of blocksOf(lines, sec.from, sec.to, () => false)) {
    const parts = b.kind === 'row' ? [{ start: 0, end: b.text.length }] : sentencesOf(b.text);
    for (const s of parts) {
      const body = b.text.slice(s.start, s.end);
      const at = lineAt(b, s.start + (body.length - body.trimStart().length));
      if (/\bfirst\b/i.test(body)) add(8, label, at, 'a sentence in the prior-art section contains the word first: ' + excerpt(body));
      if (/\b0 of 144\b|\b0\/144\b|\b281 tests\b/i.test(body)) {
        if (!/\[PA\d+\]/.test(body)) add(8, label, at, 'a sentence with a figure from interbolt or FIDES has no [PA<n>] tag: ' + excerpt(body));
        if (!/\breport(?:s|ed)?\b/i.test(body)) add(8, label, at, 'a sentence with a figure from interbolt or FIDES lacks the word report or reported: ' + excerpt(body));
      }
    }
  }
}

function ruleTen(label: string, lines: Line[], bench: string | null, evidence: string | null): { empty: boolean; line: number } | null {
  const info = benchInfo(lines);
  let block: { empty: boolean; line: number } | null = null;
  if (info.starts.length !== 1) add(10, label, info.starts[1] ?? 1, 'the README has ' + info.starts.length + ' lines "' + BENCH_START + '" (exactly one is required)');
  if (info.ends.length !== 1) add(10, label, info.ends[1] ?? 1, 'the README has ' + info.ends.length + ' lines "' + BENCH_END + '" (exactly one is required)');
  if (info.starts.length === 1 && info.ends.length === 1) {
    const s = info.starts[0] as number;
    const e = info.ends[0] as number;
    if (e < s) add(10, label, e, 'the bench end marker comes before the start marker');
    else {
      const body = lines.filter((L) => L.n > s && L.n < e && L.raw.trim() !== '');
      block = { empty: body.length === 0, line: s };
      if (bench !== null) {
        const benchLines = new Set(bench.split(/\r?\n/).map((l) => l.trimEnd()));
        for (const L of body) if (!benchLines.has(L.raw.trimEnd())) add(10, label, L.n, 'bench block line is not a line of BENCH.md: ' + excerpt(L.raw));
      }
    }
  }
  if (evidence !== null) {
    const low = evidence.toLowerCase();
    for (const L of lines) {
      for (const re of [HEX64_RE, BASE58_RE]) {
        for (const m of L.raw.matchAll(re)) {
          const h = m[0];
          const found = re === HEX64_RE ? low.includes(h.toLowerCase()) : evidence.includes(h);
          if (!found) add(10, label, L.n, 'hash ' + h.slice(0, 12) + '... is not in EVIDENCE.md');
        }
      }
    }
  }
  return block;
}

// ---------- rule 12: the file:line of the Evidence column ----------

// path:line or path:line-line; a path has a letter in it, so 10:30 and 127.0.0.1:4173 are not tokens, and the lookbehind keeps a URL
// such as https://example.org:8080/x out (its host follows a slash)
const EVIDENCE_TOKEN = /(?<![\w@.~+/-])(\/?(?:[\w@.~+-]+\/)*[\w@.~+-]+):(\d+)(?:-(\d+))?(?!\w)/g;
const SYMBOL_AFTER = /^\s*\(?\s*`([^`]+)`/;
const SYMBOL_WINDOW = 3;

type EvidenceFiles = { root: string; tracked: Set<string> | null };

function evidenceFiles(root: string, explicit: boolean): EvidenceFiles {
  if (explicit) return { root, tracked: null };
  const inside = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { root, tracked: null };
  const ls = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (ls.status !== 0) return { root, tracked: null };
  return { root, tracked: new Set(ls.stdout.split('\0').filter((f) => f !== '')) };
}

function evidenceProblems(cell: string, files: EvidenceFiles, cache: Map<string, string[] | null>): string[] {
  const problems: string[] = [];
  const spans = [...cell.matchAll(/`[^`]*`/g)].map((m) => ({ from: m.index ?? 0, to: (m.index ?? 0) + m[0].length, inner: m[0].slice(1, -1).trim() }));
  for (const m of cell.matchAll(EVIDENCE_TOKEN)) {
    const given = m[1] ?? '';
    if (!/[A-Za-z]/.test(given)) continue;
    const from = m.index ?? 0;
    const end = from + m[0].length;
    const first = Number(m[2]);
    const last = m[3] === undefined ? first : Number(m[3]);
    const tokenText = given + ':' + m[2] + (m[3] === undefined ? '' : '-' + m[3]);
    const abs = path.resolve(files.root, given);
    const rel = path.relative(files.root, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      problems.push('evidence ' + tokenText + ' names a path outside the repository root');
      continue;
    }
    let lines = cache.get(abs);
    if (lines === undefined) {
      const listed = files.tracked === null || files.tracked.has(rel.split(path.sep).join('/'));
      const text = listed ? readText(abs) : null;
      lines = text === null ? null : text.split(/\r?\n/);
      if (lines !== null && lines[lines.length - 1] === '') lines.pop();
      cache.set(abs, lines);
    }
    if (lines === null) {
      problems.push('evidence ' + tokenText + (files.tracked === null ? ' names no file under ' + shown(files.root) : ' names no tracked file (git ls-files does not list it)'));
      continue;
    }
    if (first < 1 || last < first || last > lines.length) {
      problems.push('evidence ' + tokenText + (last < first ? ' is a reversed range' : ' is outside the file (' + lines.length + ' lines, lines start at 1)'));
      continue;
    }
    // a symbol written right after the token, or after the backticks that hold the token alone
    const enclosing = spans.find((s) => s.from < from && end < s.to);
    if (enclosing !== undefined && enclosing.inner !== m[0]) continue;
    const after = enclosing !== undefined ? enclosing.to : end;
    const sym = SYMBOL_AFTER.exec(cell.slice(after));
    if (sym === null) continue;
    const symbol = (sym[1] ?? '').trim();
    if (new RegExp('^' + EVIDENCE_TOKEN.source + '$').test(symbol)) continue;
    const near = lines.slice(Math.max(1, first - SYMBOL_WINDOW) - 1, last + SYMBOL_WINDOW);
    if (!near.some((l) => l.includes(symbol))) problems.push('evidence ' + tokenText + ' has no "' + symbol + '" within ' + SYMBOL_WINDOW + ' lines');
  }
  return problems;
}

// ---------- main ----------

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    process.stderr.write('claims-lint: ' + args + '\nusage: claims-lint.ts [--readme <path>] [--docs <dir>] [--final] | --file <path> [--lines-with <regex>] [--markers <file>] [--docs <dir>] [--final]\n');
    return 2;
  }
  const cache: DocCache = { texts: new Map(), allowed: null, registered: null };
  const banned = readBanned();
  const verbList = args.file === null ? readList('claim-verbs.txt') : null;
  const verbs = (verbList ?? []).map((e) => new RegExp('\\b' + esc(e.text) + '\\b', 'i'));
  let pendingRows: ClaimRow[] = [];
  let claimsLabel = '';
  let benchBlock: { empty: boolean; line: number } | null = null;
  let readmeLabel = '';
  let payloadPending: string | null = null;
  let payloadPaths: string[] = [];

  if (args.file !== null) {
    const label = args.file;
    const text = readText(args.file);
    if (text === null) noteMissing(label);
    else {
      const lines = scanLines(text);
      const keep = (n: number): boolean => {
        if (args.linesWith === null) return true;
        return args.linesWith.test(lines[n - 1]?.raw ?? '');
      };
      if (banned !== null) rule3(label, lines, banned, false, keep);
      rule4(label, lines, keep, cache, args.docs);
      rule5(label, lines, keep, cache, args.docs);
      rule6(label, lines, keep);
      const markers = readMarkers(args.markers);
      if (markers === null) {
        payloadPending = 'payload markers missing or empty: ' + args.markers;
        payloadPaths = [args.markers];
      } else rule7File(label, lines, keep, markers);
    }
  } else {
    readmeLabel = args.readme;
    const text = readText(args.readme);
    if (text === null) noteMissing(readmeLabel);
    const docTexts = new Map<string, string | null>();
    for (const name of DOC_NAMES) docTexts.set(name, loadDoc(cache, args.docs, name));
    const lines = text === null ? [] : scanLines(text);
    const claimsText = docTexts.get('CLAIMS.md') ?? null;
    claimsLabel = docPath(args.docs, 'CLAIMS.md');
    const claims = claimsText === null ? null : claimRows(scanLines(claimsText), claimsLabel);
    const sourcesText = docTexts.get('SOURCES.md') ?? null;
    let sources: Set<string> | null = null;
    if (sourcesText !== null) {
      sources = new Set<string>();
      for (const t of tablesOf(scanLines(sourcesText))) for (const r of t.rows) if (/^S\d+$/.test(r.cells[0] ?? '')) sources.add(r.cells[0] ?? '');
    }
    const priorText = docTexts.get('PRIOR_ART.md') ?? null;
    let priorRows: number | null = null;
    if (priorText !== null) priorRows = tablesOf(scanLines(priorText))[0]?.rows.length ?? 0;
    if (claims !== null) pendingRows = claims.filter((r) => r.pending);

    if (claims !== null && (args.checkEvidence || args.final)) {
      const rootDir = path.resolve(args.root ?? path.join(path.resolve(args.docs), '..'));
      let isDir = false;
      try {
        isDir = fs.statSync(rootDir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) noteMissing(args.root ?? shown(rootDir));
      else {
        const files = evidenceFiles(rootDir, args.root !== null);
        const cache = new Map<string, string[] | null>();
        for (const row of claims) {
          if (row.pending) continue;
          for (const problem of evidenceProblems(row.evidence, files, cache)) add(12, claimsLabel, row.line, problem);
        }
      }
    }

    if (text !== null) {
      const info = benchInfo(lines);
      const benchSkip = (n: number): boolean => info.starts.length > 0 && info.ends.length > 0 && n >= (info.starts[0] as number) && n <= (info.ends.find((e) => e > (info.starts[0] as number)) ?? -1);
      ruleOne(readmeLabel, lines, claims, sources, priorRows);
      if (verbList !== null) ruleTwo(readmeLabel, lines, verbs, benchSkip);
      if (banned !== null) rule3(readmeLabel, lines, banned, true, () => true);
      rule4(readmeLabel, lines, () => true, cache, args.docs);
      rule5(readmeLabel, lines, () => true, cache, args.docs);
      rule6(readmeLabel, lines, () => true);
      ruleEight(readmeLabel, lines);
      rule9(readmeLabel, lines);
      benchBlock = ruleTen(readmeLabel, lines, docTexts.get('BENCH.md') ?? null, docTexts.get('EVIDENCE.md') ?? null);

      // rule 7: the repo's payload scan, which needs its script and a non-empty marker file
      const markers = readMarkers(args.markers);
      const problems: string[] = [];
      if (!fs.existsSync(scanScript)) {
        problems.push('payload scan script missing: ' + shown(scanScript));
        payloadPaths.push(shown(scanScript));
      }
      if (markers === null) {
        problems.push('payload markers missing or empty: ' + args.markers);
        payloadPaths.push(args.markers);
      }
      if (problems.length > 0) payloadPending = problems.join('; ');
      else {
        const run = spawnSync('bash', [scanScript], { encoding: 'utf8' });
        if (run.status !== 0) {
          const first = ((run.stdout ?? '') + (run.stderr ?? '')).split('\n').find((l) => l.trim() !== '') ?? '';
          add(7, readmeLabel, 1, 'payload scan exited ' + String(run.status) + (first === '' ? '' : ': ' + first.slice(0, 120)));
        }
      }
    }

    // rules 3, 6 and 9 on every *.md directly in the docs folder
    let names: string[] = [];
    try {
      names = fs.readdirSync(args.docs).filter((n) => n.endsWith('.md')).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const label = docPath(args.docs, name);
      const t = readText(label);
      if (t === null) continue;
      const dl = scanLines(t);
      if (banned !== null) rule3(label, dl, banned, false, () => true);
      if (name !== 'video-script.md') rule6(label, dl, () => true);
      rule9(label, dl);
    }
  }

  // pending items
  let pendingCount = 0;
  for (const r of pendingRows) {
    if (args.final) finals.push('pending row ' + r.id + ' (' + r.ticket + ') at ' + claimsLabel + ':' + r.line);
    else pendingCount++;
  }
  if (benchBlock !== null && benchBlock.empty) {
    if (args.final) finals.push('the README bench block is empty at ' + readmeLabel + ':' + benchBlock.line);
    else pendingCount++;
  }
  if (payloadPending !== null) {
    if (args.final) {
      finals.push(payloadPending);
      for (const p of payloadPaths) {
        noteMissing(p);
        finalPaths.push(p);
      }
    } else pendingCount++;
  }

  const order = findings.map((f, i) => ({ f, i })).sort((a, b) => a.f.rule - b.f.rule || a.i - b.i);
  const outLines: string[] = [];
  for (const { f } of order) outLines.push('FINDING ' + f.rule + ' ' + f.where + ' ' + f.text);
  for (const f of finals) outLines.push('FINAL ' + f);
  for (const m of missing) outLines.push('INPUT MISSING ' + m);
  const unpaired = missing.filter((m) => !finalPaths.includes(m)).length;
  const k = findings.length + finals.length + unpaired;
  let code = 0;
  if (missing.length > 0) code = 2;
  else if (k > 0) code = 1;
  if (k > 0 || missing.length > 0) outLines.push('CLAIMS LINT FAIL ' + k + ' findings');
  else if (pendingCount > 0) outLines.push('CLAIMS LINT OK (' + pendingCount + ' pending)');
  else outLines.push('CLAIMS LINT OK');
  process.stdout.write(outLines.join('\n') + '\n');
  return code;
}

process.exitCode = main();

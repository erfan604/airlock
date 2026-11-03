// Video script checker (AIR-278). Reads docs/video-script.md (the shot blocks of AIR-248) and fails on a bad draft: an uncited
// number, a caption that is too fast, a screen string that is not in the code.
//
// Usage: node scripts/video-script-check.ts [--draft] [--root <dir>] [--file <path>]
//        node scripts/video-script-check.ts [--draft] [--root <dir>] [--file <path>] --json | --links
//        node scripts/video-script-check.ts --say F<nn>
//   --draft       allow the first line DRAFT (every other rule stays on)
//   --root <dir>  the folder that holds docs/video-script.md, docs/BENCH.md, docs/EVIDENCE.md, docs/SOURCES.md, bench/golden/,
//                 fixtures/world.jsonl, runtime/recordings/chain/, web/src, contracts, runtime/src and scripts
//                 (default: the folder above this file's own folder)
//   --file <path> read another script file instead of <root>/docs/video-script.md
//   --json        print the shots and the cues for the video edit (AIR-250, AIR-280)
//   --links       print every URL of the RUN lines once, in script order (AIR-243)
//   --say F<nn>   print the Say line of dossier F<nn> on one line without its quote marks (AIR-251); reads no script
// With --json or --links only the payload goes to stdout and the findings go to stderr; the exit code is the same.
// The dossiers are always read from $AIRLOCK_RESEARCH/plan/solutions, never copied into the product repo.
//
// Output: FINDING <rule> <file>:<line> <text>, then the last line VIDEO SCRIPT OK shots=<n> seconds=<s> words=<w> or
// VIDEO SCRIPT FAIL <k> findings. A missing script or a missing file that a rule needs prints INPUT MISSING <path> as the last
// line instead. Exit 0 clean, 1 findings, 2 missing input or a usage error.
// Rules, in the order of their names: draft, lock, contiguous, total, inside, overlap, pacing, tag, say, number, screen,
// screen-fmt, untrusted, mode-words, tee, last-shot, explorer, voice, lint.
//
// Run it as `pnpm tsx scripts/video-script-check.ts` in the product repo or as plain `node scripts/video-script-check.ts` on
// Node 24. Erasable TypeScript only, standard library only. The claims lint (scripts/claims-lint.ts, AIR-276) is the one next to
// this file, run on a scratch copy of the script that holds only the words a viewer sees.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const RULES = ['draft', 'lock', 'contiguous', 'total', 'inside', 'overlap', 'pacing', 'tag', 'say', 'number', 'screen', 'screen-fmt', 'untrusted', 'mode-words', 'tee', 'last-shot', 'explorer', 'voice', 'lint'];
const MODES = ['LIVE-CONSOLE', 'LIVE-SCRIPT', 'REPLAY', 'EXPLORER', 'TERMINAL', 'BROWSER-SOURCE', 'TITLE'];
const BENCH_GROUPS = ['A', 'B', 'C', 'S', 'X', 'P', 'ALL', 'benign'];
const EXPLORER_HOSTS = ['testnet.nearblocks.io', 'nearblocks.io', 'sepolia.basescan.org'];
const MIN_TOTAL_S = 135;
const MAX_TOTAL_S = 150;
const MIN_CAPTION_S = 1.8;
const MAX_CAPTION_WORDS = 12;
const MAX_WORDS_PER_S = 2.3;
const MAX_DESC_WORDS = 8;
const EPS = 1e-9;
const BENCH_BEGIN = '<!-- BEGIN GENERATED -->';
const BENCH_END = '<!-- END GENERATED -->';
const REGISTRATION_ROW = '| TEE registration tx';
const NEARBLOCKS_TX = 'testnet.nearblocks.io/txns/';
const LOCKED_RE = /^LOCKED (\d{4})-(\d{2})-(\d{2})$/;
const LOCK_LINE_RE = /^FIRST FIVE LOCKED (\d{4})-(\d{2})-(\d{2}) sha256 ([0-9a-f]{64})$/;
const CLOCK = '(\\d+:\\d{2}(?:\\.\\d+)?)';
const SHOT_RE = new RegExp('^SHOT (S\\d+) ' + CLOCK + '-' + CLOCK + ' mode (\\S+)\\s*$');
const CAP_RE = new RegExp('^CAP (\\S+) ' + CLOCK + '-' + CLOCK + ' (.*)$');

// The number tokenizer is the one of AIR-276 rule 5 (scripts/claims-lint.ts). These seven constants are copies of its lines; a
// test compares them with claims-lint.ts, so a change there that is not made here fails the tests.
const TAG_SRC = '\\[(?:C\\d+[a-z]?|S\\d+|PA\\d+)\\]';
const TAG_ANY = new RegExp(TAG_SRC, 'g');
const CODE_RE = /(`{1,3})[^\n]*?\1/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/g;
const NUM_RE = /(?<![\w.,])(\d+(?:[.,]\d+)*%?)(?!\w)/g;
const VERSION_RE = /(?<![\w.])v?\d+(?:\.\d+){2,}(?!\w)/g;
// identifiers, not number claims: a digit run joined to a word by a hyphen (AIR-201, erfan-7116, UTC-7) and arXiv ids (2610.26438)
const IDENT_RE = /(?<![\w.])[A-Za-z][A-Za-z0-9]*-\d[\w.]*(?!\w)|(?<![\w.])\d{4}\.\d{4,5}(?:v\d+)?(?!\w|\.\d)/g;

type Tag =
  | { kind: 'say'; f: string; i: number | null; k: number | null }
  | { kind: 'bench'; config: string; group: string }
  | { kind: 'meta' }
  | { kind: 'limits' }
  | { kind: 'ev'; section: string }
  | { kind: 'golden'; name: string }
  | { kind: 'src'; id: string }
  | { kind: 'desc' };

type Shot = { id: string; mode: string; start: number; end: number; line: number; caps: Cap[]; runs: { line: number; text: string }[]; voices: Voice[] };
type Cap = { shot: Shot; cue: string; start: number; end: number; tag: Tag | null; tagText: string; text: string; line: number };
type Voice = { cue: string; text: string; line: number };
type Screen = { line: number; cue: string; text: string };
type Fmt = { line: number; cue: string; template: string; values: Map<string, string> };
type Data = { line: number; cue: string; file: string };
type Parsed = { lines: string[]; shots: Shot[]; caps: Cap[]; voices: Voice[]; screens: Screen[]; fmts: Fmt[]; datas: Data[]; scratch: string[] };
type Args = { draft: boolean; json: boolean; links: boolean; say: string | null; root: string | null; file: string | null };
type Finding = { rule: string; line: number; text: string; file: string | null; seq: number };
type SayResult = { status: 'ok'; text: string; file: string } | { status: 'nodir'; label: string } | { status: 'nofile'; label: string } | { status: 'nosay'; label: string; file: string };

const findings: Finding[] = [];
const missing: string[] = [];

const scriptDir = path.dirname(fs.realpathSync(process.argv[1] ?? '.'));

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

function add(rule: string, line: number, text: string, file: string | null = null): void {
  findings.push({ rule, line, text: text.replace(/\s+/g, ' ').trim(), file, seq: findings.length });
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

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function wordsOf(s: string): string[] {
  const t = s.trim();
  return t === '' ? [] : t.split(/\s+/);
}

function clockText(sec: number): string {
  const m = Math.floor(sec / 60 + EPS);
  const rest = sec - m * 60;
  const r = Math.round(rest * 10) / 10;
  return m + ':' + (r < 10 ? '0' : '') + String(r);
}

function parseClock(s: string): number | null {
  const m = /^(\d+):(\d{2}(?:\.\d+)?)$/.exec(s);
  if (m === null) return null;
  const sec = Number(m[2]);
  if (sec >= 60) return null;
  return Number(m[1]) * 60 + sec;
}

function excerpt(s: string): string {
  const t = norm(s);
  return t.length > 70 ? t.slice(0, 67) + '...' : t;
}

// ---------- arguments ----------

function parseArgs(argv: string[]): Args | string {
  const a: Args = { draft: false, json: false, links: false, say: null, root: null, file: null };
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i] ?? '';
    i++;
    if (flag === '--draft') a.draft = true;
    else if (flag === '--json') a.json = true;
    else if (flag === '--links') a.links = true;
    else if (flag === '--say' || flag === '--root' || flag === '--file') {
      const v = argv[i];
      if (v === undefined) return flag + ' needs a value';
      i++;
      if (flag === '--say') {
        if (!/^F\d{2}$/.test(v)) return '--say needs a dossier id such as F08';
        a.say = v;
      } else if (flag === '--root') a.root = v;
      else a.file = v;
    } else return 'unknown argument ' + flag;
  }
  if ([a.json, a.links, a.say !== null].filter((x) => x).length > 1) return '--json, --links and --say cannot be combined';
  return a;
}

// ---------- the dossiers ----------

function researchDir(): string | null {
  const env = process.env['AIRLOCK_RESEARCH'];
  return env === undefined || env === '' ? null : env;
}

// The Say line of a dossier: the line that starts `Say: "`, read up to the closing quote mark (the next line is joined with a
// space when the quote is not closed on the first); anything after the closing quote mark is dropped.
function readSay(f: string): SayResult {
  const research = researchDir();
  const pattern = '$AIRLOCK_RESEARCH/plan/solutions/' + f + '_*.md';
  if (research === null) return { status: 'nodir', label: pattern };
  const dir = path.join(research, 'plan', 'solutions');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { status: 'nodir', label: dir };
  }
  const name = names.filter((n) => n.startsWith(f + '_') && n.endsWith('.md')).sort()[0];
  if (name === undefined) return { status: 'nofile', label: path.join(dir, f + '_*.md') };
  const file = path.join(dir, name);
  const text = readText(file);
  if (text === null) return { status: 'nodir', label: file };
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('Say: '));
  if (at < 0) return { status: 'nosay', label: file, file };
  let acc = (lines[at] ?? '').slice(5).trim();
  if (!/^["“]/.test(acc)) return { status: 'nosay', label: file, file };
  acc = acc.slice(1);
  let j = at;
  for (;;) {
    const close = acc.search(/["”]/);
    if (close >= 0) return { status: 'ok', text: norm(acc.slice(0, close)), file };
    j++;
    const next = (lines[j] ?? '').trim();
    if (next === '' || j - at > 3) return { status: 'nosay', label: file, file };
    acc = acc + ' ' + next;
  }
}

function runSayMode(f: string): number {
  const r = readSay(f);
  if (r.status === 'ok') {
    process.stdout.write(r.text + '\n');
    return 0;
  }
  if (r.status === 'nodir') {
    process.stderr.write('INPUT MISSING ' + r.label + '\n');
    return 2;
  }
  const why = r.status === 'nofile' ? 'no dossier file for ' + f : 'the dossier has no Say line in the form Say: "..."';
  process.stderr.write('FINDING say ' + r.label + ':1 ' + why + '\nVIDEO SCRIPT FAIL 1 findings\n');
  return 1;
}

// ---------- tokens ----------

function maskInline(s: string, fill: string): string {
  return s.replace(CODE_RE, (m) => fill.repeat(m.length)).replace(URL_RE, (m) => fill.repeat(m.length));
}

function dropCommas(tok: string): string {
  return tok.replace(/,/g, '');
}

function stripNoise(s: string): string {
  let t = s.replace(TAG_ANY, ' ');
  t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ' ');
  t = t.replace(VERSION_RE, ' ');
  return t.replace(IDENT_RE, ' ');
}

// The number tokens of a caption, as AIR-276 rule 5 reads a line (code spans and URLs are not numbers).
function captionTokens(text: string): string[] {
  const s = stripNoise(maskInline(text, ' '));
  return [...s.matchAll(NUM_RE)].map((m) => m[1] ?? '');
}

// The number tokens of a source text. The contents of code spans and fenced code count here: a caption may quote a number that
// the source shows in code. URLs are still not numbers. Commas are removed for the comparison.
function sourceTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const s = stripNoise(line.replace(/`/g, ' ').replace(URL_RE, (m) => ' '.repeat(m.length)));
    for (const m of s.matchAll(NUM_RE)) out.add(dropCommas(m[1] ?? ''));
  }
  return out;
}

function urlsIn(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'<>`]+/g) ?? [];
  return found.map((u) => u.replace(/[.,;:!?)\]}]+$/, ''));
}

// ---------- tables ----------

function isDelimiter(s: string): boolean {
  return s.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
}

function splitRow(s: string): string[] {
  let t = s.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

// ---------- parsing the script ----------

function parseTag(inner: string): Tag | null {
  if (inner === 'DESC') return { kind: 'desc' };
  if (inner === 'BENCH:meta') return { kind: 'meta' };
  if (inner === 'BENCH:limits') return { kind: 'limits' };
  let m = /^SAY:(F\d{2})(?:#(\d+)\/(\d+))?$/.exec(inner);
  if (m !== null) {
    if (m[2] === undefined) return { kind: 'say', f: m[1] ?? '', i: null, k: null };
    const i = Number(m[2]);
    const k = Number(m[3]);
    return i >= 1 && i <= k ? { kind: 'say', f: m[1] ?? '', i, k } : null;
  }
  m = /^BENCH:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z]+)$/.exec(inner);
  if (m !== null) return BENCH_GROUPS.includes(m[2] ?? '') ? { kind: 'bench', config: m[1] ?? '', group: m[2] ?? '' } : null;
  m = /^EV:(.+)$/.exec(inner);
  if (m !== null && (m[1] ?? '').trim() !== '') return { kind: 'ev', section: (m[1] ?? '').trim() };
  m = /^GOLDEN:([A-Za-z0-9._-]+)$/.exec(inner);
  if (m !== null) return { kind: 'golden', name: m[1] ?? '' };
  m = /^SRC:(S\d+)$/.exec(inner);
  if (m !== null) return { kind: 'src', id: m[1] ?? '' };
  return null;
}

// The part of a CAP line after the time range: one tag right after the range, then the caption text.
function splitCaption(rest: string, line: number): { tag: Tag | null; tagText: string; text: string } {
  const groups = [...rest.matchAll(/\[[^\]]*\]/g)];
  const lead = /^(?:\s*\[[^\]]*\])+\s*/.exec(rest);
  const text = (lead !== null ? rest.slice(lead[0].length) : rest.replace(/\[[^\]]*\]/g, ' ')).trim();
  if (groups.length === 0) {
    add('tag', line, 'caption has no tag; expected one of [SAY:F<nn>#<i>/<k>], [SAY:F<nn>], [BENCH:...], [EV:<section>], [GOLDEN:<name>], [SRC:S<n>] or [DESC]');
    return { tag: null, tagText: '', text };
  }
  const first = (groups[0] as RegExpMatchArray)[0];
  if (groups.length > 1) {
    add('tag', line, 'caption has ' + groups.length + ' tags, exactly one is required: ' + groups.map((g) => g[0]).join(' '));
    return { tag: null, tagText: first, text };
  }
  if (lead === null) add('tag', line, 'the tag ' + first + ' must come right after the time range');
  const tag = parseTag(first.slice(1, -1));
  if (tag === null) add('tag', line, 'the tag ' + first + ' is not one of the valid forms');
  return { tag: lead === null ? null : tag, tagText: first, text };
}

function parseScript(text: string): Parsed {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const p: Parsed = { lines, shots: [], caps: [], voices: [], screens: [], fmts: [], datas: [], scratch: lines.map(() => '') };
  let cur: Shot | null = null;
  let afterBadShot = false;
  const orphan = (n: number, what: string): void => {
    if (afterBadShot) return;
    if (what === 'CAP') add('inside', n, 'caption line before the first SHOT line');
    else add('contiguous', n, what + ' line before the first SHOT line');
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const n = i + 1;
    let m: RegExpExecArray | null;
    if (line.startsWith('SHOT ')) {
      m = SHOT_RE.exec(line);
      const start = m === null ? null : parseClock(m[2] ?? '');
      const end = m === null ? null : parseClock(m[3] ?? '');
      if (m === null || start === null || end === null) {
        add('contiguous', n, 'SHOT line is not in the form SHOT S<nn> <m:ss>-<m:ss> mode <MODE>: ' + excerpt(line));
        cur = null;
        afterBadShot = true;
        continue;
      }
      const mode = m[4] ?? '';
      cur = { id: m[1] ?? '', mode, start, end, line: n, caps: [], runs: [], voices: [] };
      p.shots.push(cur);
      afterBadShot = false;
      if (!MODES.includes(mode)) add('mode-words', n, 'shot ' + cur.id + ' has the unknown mode ' + mode + ' (modes: ' + MODES.join(', ') + ')');
    } else if (line.startsWith('RUN ')) {
      if (cur === null) orphan(n, 'RUN');
      else cur.runs.push({ line: n, text: line.slice(4) });
    } else if (line.startsWith('CAP ')) {
      m = CAP_RE.exec(line);
      const start = m === null ? null : parseClock(m[2] ?? '');
      const end = m === null ? null : parseClock(m[3] ?? '');
      if (m === null || start === null || end === null) {
        add('tag', n, 'CAP line is not in the form CAP <cue> <m:ss>-<m:ss> [tag] text: ' + excerpt(line));
        continue;
      }
      if (cur === null) {
        orphan(n, 'CAP');
        continue;
      }
      const sp = splitCaption(m[4] ?? '', n);
      const cap: Cap = { shot: cur, cue: m[1] ?? '', start, end, tag: sp.tag, tagText: sp.tagText, text: sp.text, line: n };
      cur.caps.push(cap);
      p.caps.push(cap);
      p.scratch[i] = sp.text;
    } else if (line.startsWith('VOICE ')) {
      m = /^VOICE (\S+) (.*)$/.exec(line);
      if (m === null) {
        add('voice', n, 'VOICE line is not in the form VOICE <cue id> <text>: ' + excerpt(line));
        continue;
      }
      if (cur === null) {
        orphan(n, 'VOICE');
        continue;
      }
      const v: Voice = { cue: m[1] ?? '', text: (m[2] ?? '').trim(), line: n };
      cur.voices.push(v);
      p.voices.push(v);
      p.scratch[i] = v.text;
    } else if (line.startsWith('SCREEN-FMT ')) {
      m = /^SCREEN-FMT (\S+) "(.*)"((?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*)\s*$/.exec(line);
      if (m === null) {
        add('screen-fmt', n, 'SCREEN-FMT line is not in the form SCREEN-FMT <cue> "<template>" name=value ...: ' + excerpt(line));
        continue;
      }
      if (cur === null) {
        orphan(n, 'SCREEN-FMT');
        continue;
      }
      const values = new Map<string, string>();
      for (const tok of (m[3] ?? '').trim().split(/\s+/)) {
        const eq = tok.indexOf('=');
        if (eq > 0) values.set(tok.slice(0, eq), tok.slice(eq + 1));
      }
      p.fmts.push({ line: n, cue: m[1] ?? '', template: m[2] ?? '', values });
      p.scratch[i] = m[2] ?? '';
    } else if (line.startsWith('SCREEN-DATA ')) {
      m = /^SCREEN-DATA (\S+) (\S+)(?:\s.*)?$/.exec(line);
      if (m === null) {
        add('screen', n, 'SCREEN-DATA line is not in the form SCREEN-DATA <cue> <file> ...: ' + excerpt(line));
        continue;
      }
      if (cur === null) {
        orphan(n, 'SCREEN-DATA');
        continue;
      }
      p.datas.push({ line: n, cue: m[1] ?? '', file: m[2] ?? '' });
    } else if (line.startsWith('SCREEN ')) {
      m = /^SCREEN (\S+) "(.*)"\s*$/.exec(line);
      if (m === null) {
        add('screen', n, 'SCREEN line is not in the form SCREEN <cue> "<exact string>": ' + excerpt(line));
        continue;
      }
      if (cur === null) {
        orphan(n, 'SCREEN');
        continue;
      }
      p.screens.push({ line: n, cue: m[1] ?? '', text: m[2] ?? '' });
      p.scratch[i] = m[2] ?? '';
    }
  }
  return p;
}

// ---------- the lock hash of AIR-282 check 5: awk '/^SHOT /{keep = ($2 !~ /^(S02|S06)$/)} keep' | sha256sum ----------

function lockHash(bytes: Buffer): string {
  const records = bytes.toString('latin1').split('\n');
  if (records.length > 0 && records[records.length - 1] === '') records.pop();
  let keep = false;
  const out: string[] = [];
  for (const r of records) {
    if (r.startsWith('SHOT ')) keep = !/^(S02|S06)$/.test(r.split(/[ \t]+/)[1] ?? '');
    if (keep) out.push(r + '\n');
  }
  return crypto.createHash('sha256').update(Buffer.from(out.join(''), 'latin1')).digest('hex');
}

// ---------- the rules ----------

function validDate(y: string | undefined, m: string | undefined, d: string | undefined): boolean {
  const mo = Number(m);
  const da = Number(d);
  return y !== undefined && mo >= 1 && mo <= 12 && da >= 1 && da <= 31;
}

function ruleDraft(p: Parsed, args: Args): void {
  const first = p.lines[0] ?? '';
  const m = LOCKED_RE.exec(first);
  if (m !== null) {
    if (!validDate(m[1], m[2], m[3])) add('draft', 1, 'line 1 has an impossible date: ' + first);
  } else if (first === 'DRAFT') {
    if (!args.draft) add('draft', 1, 'line 1 is DRAFT: the whole script is locked only when line 1 reads LOCKED <yyyy-mm-dd> (run with --draft until then)');
  } else add('draft', 1, 'line 1 must be LOCKED <yyyy-mm-dd>' + (args.draft ? ' or DRAFT' : '') + ', got: ' + excerpt(first));
}

function ruleLock(p: Parsed, bytes: Buffer, args: Args): void {
  const second = p.lines[1] ?? '';
  if (second.trim() !== '' && !second.startsWith('SHOT ')) {
    const m = LOCK_LINE_RE.exec(second);
    if (m === null || !validDate(m[1], m[2], m[3])) add('lock', 2, 'line 2 must read FIRST FIVE LOCKED <yyyy-mm-dd> sha256 <64 hex>, got: ' + excerpt(second));
    else {
      const have = lockHash(bytes);
      if (have !== m[4]) add('lock', 2, 'the hash of the locked shots is ' + have + ' but line 2 says ' + m[4] + ': a locked shot changed');
    }
  }
  for (const s of p.shots) {
    if (s.caps.length > 0 || s.voices.length > 0) continue;
    if (args.draft && (s.id === 'S02' || s.id === 'S06')) continue;
    add('lock', s.line, 'shot ' + s.id + ' has no CAP line' + (args.draft ? ': only S02 and S06 may be bare, and only under --draft' : ': a bare block is allowed only for S02 and S06 under --draft'));
  }
}

function ruleShots(p: Parsed): number {
  let prevEnd = 0;
  const seen = new Set<string>();
  p.shots.forEach((s, idx) => {
    if (s.end <= s.start + EPS) add('contiguous', s.line, 'shot ' + s.id + ' ends at ' + clockText(s.end) + ', which is not after its start ' + clockText(s.start));
    if (seen.has(s.id)) add('contiguous', s.line, 'shot id ' + s.id + ' is used twice');
    seen.add(s.id);
    if (idx === 0) {
      if (Math.abs(s.start) > EPS) add('contiguous', s.line, 'the first shot ' + s.id + ' starts at ' + clockText(s.start) + ', not at 0:00');
    } else if (Math.abs(s.start - prevEnd) > EPS) {
      add('contiguous', s.line, 'shot ' + s.id + ' starts at ' + clockText(s.start) + ' but the shot before it ends at ' + clockText(prevEnd));
    }
    prevEnd = s.end;
  });
  const total = p.shots.length === 0 ? 0 : (p.shots[p.shots.length - 1] as Shot).end;
  if (p.shots.length === 0) add('contiguous', 1, 'the script has no SHOT line');
  if (total < MIN_TOTAL_S - EPS || total > MAX_TOTAL_S + EPS) add('total', 1, 'the total is ' + total + ' s, it must be ' + MIN_TOTAL_S + ' to ' + MAX_TOTAL_S + ' s');
  return total;
}

let claimVerbs: RegExp[] | null = null;

function loadClaimVerbs(): RegExp[] | null {
  if (claimVerbs !== null) return claimVerbs;
  const p = path.join(scriptDir, '..', 'docs', 'claim-verbs.txt');
  const t = readText(p);
  if (t === null) {
    noteMissing(shown(p));
    return null;
  }
  claimVerbs = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => new RegExp('\\b' + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'));
  return claimVerbs;
}

function ruleCaptions(p: Parsed): void {
  for (const c of p.caps) {
    const dur = c.end - c.start;
    const w = wordsOf(c.text).length;
    if (dur <= EPS) add('inside', c.line, 'caption ' + c.cue + ' ends at ' + clockText(c.end) + ', which is not after its start ' + clockText(c.start));
    else if (c.start < c.shot.start - EPS || c.end > c.shot.end + EPS) {
      add('inside', c.line, 'caption ' + c.cue + ' (' + clockText(c.start) + '-' + clockText(c.end) + ') is outside its shot ' + c.shot.id + ' (' + clockText(c.shot.start) + '-' + clockText(c.shot.end) + ')');
    }
    if (dur > EPS) {
      if (dur < MIN_CAPTION_S - EPS) add('pacing', c.line, 'caption ' + c.cue + ' is on screen ' + String(Math.round(dur * 100) / 100) + ' s, the minimum is ' + MIN_CAPTION_S + ' s');
      if (w > MAX_WORDS_PER_S * dur + EPS) add('pacing', c.line, 'caption ' + c.cue + ' has ' + (w / dur).toFixed(2) + ' words per second (' + w + ' words in ' + String(Math.round(dur * 100) / 100) + ' s), the maximum is ' + MAX_WORDS_PER_S);
    }
    if (w > MAX_CAPTION_WORDS) add('pacing', c.line, 'caption ' + c.cue + ' has ' + w + ' words, the maximum is ' + MAX_CAPTION_WORDS);
    if (w === 0 && c.tag !== null) add('tag', c.line, 'caption ' + c.cue + ' has a tag and no text');
    if (c.tag !== null && c.tag.kind === 'desc') {
      if (w > MAX_DESC_WORDS) add('tag', c.line, 'the DESC caption ' + c.cue + ' has ' + w + ' words, the maximum is ' + MAX_DESC_WORDS);
      const verbs = loadClaimVerbs();
      const hit = verbs === null ? undefined : verbs.find((v) => v.test(c.text));
      if (hit !== undefined) add('tag', c.line, 'the DESC caption ' + c.cue + ' holds a claim verb (' + hit.source.replace(/\\b/g, '') + '): a DESC caption describes what is on screen and claims nothing');
    }
  }
  const seen = new Set<string>();
  for (const c of p.caps) {
    if (seen.has(c.cue)) add('tag', c.line, 'the cue id ' + c.cue + ' is used by two captions');
    seen.add(c.cue);
  }
  const byStart = [...p.caps].sort((a, b) => a.start - b.start || a.end - b.end || a.line - b.line);
  let last: Cap | null = null;
  for (const c of byStart) {
    if (last !== null && c.start < last.end - EPS) add('overlap', c.line, 'caption ' + c.cue + ' starts at ' + clockText(c.start) + ' before caption ' + last.cue + ' ends at ' + clockText(last.end));
    if (last === null || c.end > last.end) last = c;
  }
}

function ruleSay(p: Parsed): void {
  const cache = new Map<string, SayResult>();
  const sayOf = (f: string): SayResult => {
    const hit = cache.get(f);
    if (hit !== undefined) return hit;
    const r = readSay(f);
    cache.set(f, r);
    return r;
  };
  const parts = new Map<string, { cap: Cap; i: number; k: number }[]>();
  const wholes: { cap: Cap; f: string }[] = [];
  for (const c of p.caps) {
    if (c.tag === null || c.tag.kind !== 'say') continue;
    if (c.tag.i === null || c.tag.k === null) wholes.push({ cap: c, f: c.tag.f });
    else {
      const list = parts.get(c.tag.f) ?? [];
      list.push({ cap: c, i: c.tag.i, k: c.tag.k });
      parts.set(c.tag.f, list);
    }
  }
  // returns the dossier text, or null after reporting why there is none
  const dossier = (f: string, line: number): string | null => {
    const r = sayOf(f);
    if (r.status === 'ok') return r.text;
    if (r.status === 'nodir') noteMissing(r.label);
    else if (r.status === 'nofile') add('say', line, 'no dossier file ' + f + '_*.md under $AIRLOCK_RESEARCH/plan/solutions, so ' + f + ' has no Say line to compare');
    else add('say', line, 'the dossier ' + path.basename(r.file) + ' has no Say line in the form Say: "..."');
    return null;
  };
  for (const w of wholes) {
    const want = dossier(w.f, w.cap.line);
    if (want !== null && norm(w.cap.text) !== want) add('say', w.cap.line, 'caption ' + w.cap.cue + ' is [SAY:' + w.f + '] but differs from the dossier line: caption "' + excerpt(w.cap.text) + '", dossier "' + excerpt(want) + '"');
  }
  for (const [f, list] of parts) {
    const first = (list[0] as { cap: Cap; i: number; k: number }).cap;
    const ks = new Set(list.map((x) => x.k));
    if (ks.size > 1) {
      add('say', first.line, 'the parts of ' + f + ' disagree on how many parts there are: ' + [...ks].join(', '));
      continue;
    }
    const k = (list[0] as { cap: Cap; i: number; k: number }).k;
    const got = list.map((x) => x.i);
    if (list.length !== k || !got.every((v, idx) => v === idx + 1)) {
      add('say', first.line, 'the parts of ' + f + ' are ' + got.join(',') + ' of ' + k + ', expected parts 1 to ' + k + ' once each and in script order');
      continue;
    }
    const want = dossier(f, first.line);
    const joined = list.map((x) => norm(x.cap.text)).join(' ');
    if (want !== null && joined !== want) add('say', first.line, 'the ' + k + ' parts of ' + f + ' joined with single spaces differ from the dossier line: script "' + excerpt(joined) + '", dossier "' + excerpt(want) + '"');
  }
}

// ---------- the sources of the number rule ----------

type Ctx = { rootAbs: string; label: (rel: string) => string; cache: Map<string, string | null> };

function readRoot(ctx: Ctx, rel: string): string | null {
  if (!ctx.cache.has(rel)) {
    const t = readText(path.join(ctx.rootAbs, rel));
    ctx.cache.set(rel, t);
    if (t === null) noteMissing(ctx.label(rel));
  }
  return ctx.cache.get(rel) ?? null;
}

type Bench = { rows: Map<string, string>; meta: string | null; outside: string };

function loadBench(ctx: Ctx): Bench | null {
  const text = readRoot(ctx, 'docs/BENCH.md');
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  const b = lines.findIndex((l) => l.trim() === BENCH_BEGIN);
  const e = lines.findIndex((l, i) => i > b && l.trim() === BENCH_END);
  const rows = new Map<string, string>();
  let meta: string | null = null;
  let outside = text;
  if (b >= 0 && e > b) {
    outside = lines.filter((_, i) => i < b || i > e).join('\n');
    let table: 'attack' | 'benign' | null = null;
    for (let i = b + 1; i < e; i++) {
      const line = lines[i] ?? '';
      if (meta === null && line.startsWith('model ')) meta = line;
      if (!line.trimStart().startsWith('|')) {
        table = null;
        continue;
      }
      if (isDelimiter(line)) continue;
      const cells = splitRow(line);
      if (cells[0] === 'Config' && cells[1] === 'Group') table = 'attack';
      else if (cells[0] === 'Config' && cells[1] === 'Runs') table = 'benign';
      else if (table === 'attack' || table === 'benign') {
        const suffix = table === 'attack' ? '/' + (cells[1] ?? '') : '/benign';
        const name = cells[0] ?? '';
        rows.set(name + suffix, line);
        // a derived baseline is named in a tag without its note: CAPS (derived from V0) is [BENCH:CAPS/ALL]
        const bare = name.replace(/ \(derived from [^)]*\)$/, '');
        if (bare !== name && !rows.has(bare + suffix)) rows.set(bare + suffix, line);
      }
    }
  }
  return { rows, meta, outside };
}

type Source = { text: string; what: string } | { problem: string } | null;

function sourceOf(ctx: Ctx, tag: Tag, benchRef: { v: Bench | null | undefined }): Source {
  if (tag.kind === 'bench' || tag.kind === 'meta' || tag.kind === 'limits') {
    if (benchRef.v === undefined) benchRef.v = loadBench(ctx);
    const b = benchRef.v;
    if (b === null || b === undefined) return null;
    if (tag.kind === 'limits') return { text: b.outside, what: 'the hand-written text of docs/BENCH.md' };
    if (tag.kind === 'meta') return b.meta === null ? { problem: 'the generated block of docs/BENCH.md has no header line starting "model "' } : { text: b.meta, what: 'the header line of docs/BENCH.md' };
    const key = tag.config + '/' + tag.group;
    const row = b.rows.get(key);
    const table = tag.group === 'benign' ? 'Benign tasks' : 'Attack groups';
    return row === undefined ? { problem: 'the ' + table + ' table of the generated block of docs/BENCH.md has no row for ' + key } : { text: row, what: 'the ' + key + ' row of docs/BENCH.md' };
  }
  if (tag.kind === 'ev') {
    const text = readRoot(ctx, 'docs/EVIDENCE.md');
    if (text === null) return null;
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => {
      const m = /^##(?!#)\s+(.*?)\s*$/.exec(l);
      return m !== null && m[1] === tag.section;
    });
    if (at < 0) return { problem: 'docs/EVIDENCE.md has no "## ' + tag.section + '" heading' };
    let to = lines.length;
    for (let i = at + 1; i < lines.length; i++) {
      if (/^#{1,2}(?!#)\s/.test(lines[i] ?? '')) {
        to = i;
        break;
      }
    }
    return { text: lines.slice(at + 1, to).join('\n'), what: 'the section "' + tag.section + '" of docs/EVIDENCE.md' };
  }
  if (tag.kind === 'src') {
    const text = readRoot(ctx, 'docs/SOURCES.md');
    if (text === null) return null;
    const row = text.split(/\r?\n/).find((l) => l.trimStart().startsWith('|') && splitRow(l)[0] === tag.id);
    return row === undefined ? { problem: 'docs/SOURCES.md has no row ' + tag.id } : { text: row, what: 'the row ' + tag.id + ' of docs/SOURCES.md' };
  }
  if (tag.kind === 'golden') {
    const golden = readRoot(ctx, 'bench/golden/' + tag.name + '.json');
    const world = readRoot(ctx, 'fixtures/world.jsonl');
    if (golden === null || world === null) return null;
    return { text: golden + '\n' + world, what: 'bench/golden/' + tag.name + '.json and fixtures/world.jsonl' };
  }
  return null;
}

function goldenFacts(c: Cap, tag: { kind: 'golden'; name: string }, goldenText: string): void {
  let json: unknown = null;
  let parsed = true;
  try {
    json = JSON.parse(goldenText);
  } catch {
    parsed = false;
  }
  const runs = [...c.text.matchAll(/\brun (\d+) of (\d+)\b/gi)];
  const hexes = [...c.text.matchAll(/\b(?:0x)?[0-9a-fA-F]{6,}\b/g)].map((m) => m[0]).filter((t) => /^0x/i.test(t) || (/[0-9]/.test(t) && /[a-fA-F]/.test(t)));
  const obj = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  for (const r of runs) {
    const k = Number(r[1]);
    const n = Number(r[2]);
    const run = obj === null ? null : obj['run'];
    if (run !== null && run !== undefined && typeof run === 'object' && typeof (run as Record<string, unknown>)['k'] === 'number') {
      const rr = run as Record<string, unknown>;
      if (rr['k'] !== k || rr['n'] !== n) add('number', c.line, 'caption ' + c.cue + ' says run ' + k + ' of ' + n + ' but bench/golden/' + tag.name + '.json has run ' + String(rr['k']) + ' of ' + String(rr['n']));
    } else if (!goldenText.includes('run ' + k + ' of ' + n)) {
      add('number', c.line, 'caption ' + c.cue + ' says run ' + k + ' of ' + n + ' but bench/golden/' + tag.name + '.json has no run key and no such text');
    }
  }
  if (hexes.length === 0) return;
  const txs = obj !== null && Array.isArray(obj['txs']) ? (obj['txs'] as unknown[]) : [];
  const hashes = txs.map((t) => (t !== null && typeof t === 'object' ? String((t as Record<string, unknown>)['hash'] ?? '') : '').toLowerCase().replace(/^0x/, ''));
  for (const h of hexes) {
    const body = h.toLowerCase().replace(/^0x/, '');
    if (!parsed) add('number', c.line, 'caption ' + c.cue + ' quotes the hash prefix ' + h + ' but bench/golden/' + tag.name + '.json is not valid JSON');
    else if (!hashes.some((x) => x.startsWith(body))) add('number', c.line, 'caption ' + c.cue + ' quotes the hash prefix ' + h + ' which is a prefix of no txs hash of bench/golden/' + tag.name + '.json');
  }
}

function ruleNumber(p: Parsed, ctx: Ctx): void {
  const benchRef: { v: Bench | null | undefined } = { v: undefined };
  for (const c of p.caps) {
    const tag = c.tag;
    if (tag === null || tag.kind === 'say') continue;
    const toks = captionTokens(c.text);
    if (tag.kind === 'desc') {
      if (toks.length > 0) add('number', c.line, 'the DESC caption ' + c.cue + ' holds the number ' + toks.join(', ') + ': a number needs a BENCH, GOLDEN, EV or SRC tag');
      continue;
    }
    const src = sourceOf(ctx, tag, benchRef);
    if (src === null) continue;
    if ('problem' in src) {
      add('tag', c.line, 'caption ' + c.cue + ' has a tag that names nothing: ' + src.problem);
      for (const t of toks) add('number', c.line, 'caption ' + c.cue + ' has the number ' + t + ' but its tag names no source to find it in');
      continue;
    }
    if (toks.length > 0) {
      const have = sourceTokens(src.text);
      for (const t of toks) {
        if (!have.has(dropCommas(t))) add('number', c.line, 'caption ' + c.cue + ' has the number ' + t + ' which is not a token of ' + src.what);
      }
    }
    if (tag.kind === 'golden') {
      const golden = readRoot(ctx, 'bench/golden/' + tag.name + '.json');
      if (golden !== null) goldenFacts(c, tag, golden);
    }
  }
}

// ---------- strings on screen ----------

function gitGrepFinds(rootAbs: string, needle: string): { found: boolean; error: string | null } {
  let ceiling = path.dirname(rootAbs);
  try {
    ceiling = path.dirname(fs.realpathSync(rootAbs));
  } catch {
    // keep the plain parent
  }
  // The ceiling stops git from reading a .gitignore above the root (for example a target/ rule when the root is a copy under
  // target/); a root that is itself a repository is still found, because git looks at its own folder first.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: ceiling };
  // 'contracts/*/src' alone matches only a path that ends in src, so no file under it is ever searched (measured, also for tracked
  // files); the extra 'contracts/*/src/**' makes the search reach the contract sources the rule names.
  const r = spawnSync('git', ['grep', '--no-index', '--exclude-standard', '-F', '-q', '-e', needle, '--', 'web/src', 'contracts/*/src', 'contracts/*/src/**', 'runtime/src', 'scripts'], { cwd: rootAbs, encoding: 'utf8', env });
  if (r.error !== undefined) return { found: false, error: String(r.error.message) };
  if (r.status === 0) return { found: true, error: null };
  if (r.status === 1) return { found: false, error: null };
  return { found: false, error: 'git grep exited ' + String(r.status) + ': ' + (r.stderr ?? '').split('\n')[0] };
}

function ruleScreen(p: Parsed, ctx: Ctx): void {
  const memo = new Map<string, { found: boolean; error: string | null }>();
  const find = (needle: string): { found: boolean; error: string | null } => {
    const hit = memo.get(needle);
    if (hit !== undefined) return hit;
    const r = gitGrepFinds(ctx.rootAbs, needle);
    memo.set(needle, r);
    return r;
  };
  for (const s of p.screens) {
    if (s.text === '') {
      add('screen', s.line, 'SCREEN ' + s.cue + ' is an empty string');
      continue;
    }
    const r = find(s.text);
    if (r.error !== null) add('screen', s.line, 'SCREEN ' + s.cue + ' could not be searched: ' + r.error);
    else if (!r.found) add('screen', s.line, 'SCREEN ' + s.cue + ' "' + excerpt(s.text) + '" is not in web/src, contracts/*/src, runtime/src or scripts');
  }
  for (const d of p.datas) {
    let ok = false;
    try {
      ok = fs.statSync(path.join(ctx.rootAbs, d.file)).isFile();
    } catch {
      ok = false;
    }
    if (!ok) add('screen', d.line, 'SCREEN-DATA ' + d.cue + ' names ' + d.file + ' which does not exist under the root');
  }
}

// decimal text to an integer of the given number of decimals; null when it is not a plain decimal or has too many digits
function toBase(dec: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(dec);
  if (m === null) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt((m[1] ?? '0') + frac.padEnd(decimals, '0'));
}

// the first value of a key, found by a depth first search that visits keys in file order
function findKey(node: unknown, key: string): unknown {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findKey(x, key);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const o = node as Record<string, unknown>;
  if (key in o) return o[key];
  for (const k of Object.keys(o)) {
    const r = findKey(o[k], key);
    if (r !== undefined) return r;
  }
  return undefined;
}

type Recorded = { amount: bigint; payee: string } | { problem: string } | null;

function loadRecorded(ctx: Ctx): Recorded {
  const rel = 'runtime/recordings/chain/b01-escalate.json';
  const text = readRoot(ctx, rel);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { problem: rel + ' is not valid JSON' };
  }
  const entries = json !== null && typeof json === 'object' ? (json as Record<string, unknown>)['entries'] : undefined;
  if (!Array.isArray(entries)) return { problem: rel + ' has no entries array' };
  const entry = entries.find((e) => e !== null && typeof e === 'object' && (e as Record<string, unknown>)['kind'] === 'view' && (e as Record<string, unknown>)['method'] === 'get_request' && (e as Record<string, unknown>)['result'] !== null && (e as Record<string, unknown>)['result'] !== undefined);
  if (entry === undefined) return { problem: rel + ' has no get_request view entry with a result' };
  const amount = findKey(entry, 'amount');
  const payee = findKey(entry, 'payee');
  if (typeof amount !== 'string' && typeof amount !== 'number') return { problem: 'the get_request entry of ' + rel + ' has no amount' };
  if (typeof payee !== 'string') return { problem: 'the get_request entry of ' + rel + ' has no payee' };
  const digits = String(amount);
  if (!/^\d+$/.test(digits)) return { problem: 'the recorded amount ' + digits + ' is not an integer' };
  return { amount: BigInt(digits), payee };
}

function ruleScreenFmt(p: Parsed, ctx: Ctx): void {
  if (p.fmts.length === 0) return;
  const recorded = loadRecorded(ctx);
  for (const f of p.fmts) {
    const g = gitGrepFinds(ctx.rootAbs, f.template);
    if (g.error !== null) add('screen-fmt', f.line, 'SCREEN-FMT ' + f.cue + ' could not be searched: ' + g.error);
    else if (!g.found) add('screen-fmt', f.line, 'the template of SCREEN-FMT ' + f.cue + ' "' + excerpt(f.template) + '" is not in web/src, contracts/*/src, runtime/src or scripts');
    for (const m of f.template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const name = m[1] ?? '';
      if (!f.values.has(name)) add('screen-fmt', f.line, 'the template of SCREEN-FMT ' + f.cue + ' has {' + name + '} but the line has no ' + name + '=<value>');
    }
    if (recorded === null) continue;
    if ('problem' in recorded) {
      add('screen-fmt', f.line, recorded.problem);
      continue;
    }
    const amount = f.values.get('amount');
    if (amount !== undefined) {
      const symbol = f.values.get('symbol');
      if (symbol !== 'NEAR') add('screen-fmt', f.line, 'amount=' + amount + ' needs symbol=NEAR, got ' + (symbol === undefined ? 'no symbol' : 'symbol=' + symbol));
      else {
        const units = toBase(amount, 24);
        if (units === null) add('screen-fmt', f.line, 'amount=' + amount + ' is not a decimal with at most 24 digits after the point');
        else if (units !== recorded.amount) add('screen-fmt', f.line, 'amount=' + amount + ' is ' + units + ' but the recorded request has ' + recorded.amount);
      }
    }
    const to = f.values.get('to');
    if (to !== undefined && to !== recorded.payee) add('screen-fmt', f.line, 'to=' + to + ' differs from the recorded payee ' + recorded.payee);
  }
}

// ---------- the remaining rules ----------

function ruleWords(p: Parsed, ctx: Ctx): void {
  p.lines.forEach((l, i) => {
    if (l.includes('UntrustedAmount')) add('untrusted', i + 1, 'the word UntrustedAmount belongs to the strict bench configuration and is never named in the script');
  });
  for (const s of p.shots) {
    const said = (c: Cap): boolean => /\b(replay|recorded)\b/i.test(c.text);
    if (s.mode === 'REPLAY' && !s.caps.some(said)) add('mode-words', s.line, 'the REPLAY shot ' + s.id + ' has no caption with the word replay or recorded');
    if (s.mode.startsWith('LIVE')) {
      for (const c of s.caps) if (said(c)) add('mode-words', c.line, 'caption ' + c.cue + ' of the live shot ' + s.id + ' says replay or recorded');
    }
  }
  let registered: boolean | null | undefined;
  for (const c of p.caps) {
    const sayF07 = c.tag !== null && c.tag.kind === 'say' && c.tag.f === 'F07';
    if (!sayF07 && !/\bTEE\b/.test(c.text)) continue;
    if (registered === undefined) {
      const text = readRoot(ctx, 'docs/EVIDENCE.md');
      registered = text === null ? null : text.split(/\r?\n/).some((l) => l.startsWith(REGISTRATION_ROW) && l.includes(NEARBLOCKS_TX));
    }
    if (registered === false) add('tee', c.line, 'caption ' + c.cue + ' is about the TEE but docs/EVIDENCE.md has no "' + REGISTRATION_ROW + '" row with a ' + NEARBLOCKS_TX + ' link');
  }
  const last = p.shots[p.shots.length - 1];
  if (last !== undefined) {
    if (!last.runs.some((r) => r.text.includes('pnpm i && pnpm demo'))) add('last-shot', last.line, 'the last shot ' + last.id + ' has no RUN line containing "pnpm i && pnpm demo"');
    const repo = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/;
    const onRun = last.runs.some((r) => repo.test(r.text));
    const onCap = last.caps.some((c) => repo.test(c.text));
    if (!onRun && !onCap) add('last-shot', last.line, 'the last shot ' + last.id + ' has no https://github.com/<owner>/<repo> URL on a RUN or CAP line');
  }
  let evidence: string | null | undefined;
  for (const s of p.shots) {
    for (const r of s.runs) {
      for (const u of urlsIn(r.text)) {
        let host = '';
        try {
          host = new URL(u).hostname;
        } catch {
          host = '';
        }
        if (!EXPLORER_HOSTS.includes(host)) continue;
        if (evidence === undefined) evidence = readRoot(ctx, 'docs/EVIDENCE.md');
        if (evidence !== null && !evidence.includes(u)) add('explorer', r.line, 'the explorer URL ' + u + ' is not in docs/EVIDENCE.md');
      }
    }
  }
}

function ruleVoice(p: Parsed): void {
  const caps = new Map<string, Cap>();
  for (const c of p.caps) if (!caps.has(c.cue)) caps.set(c.cue, c);
  const seen = new Set<string>();
  for (const v of p.voices) {
    const c = caps.get(v.cue);
    if (seen.has(v.cue)) add('voice', v.line, 'two VOICE lines for the cue ' + v.cue);
    seen.add(v.cue);
    if (c === undefined) add('voice', v.line, 'the VOICE line for ' + v.cue + ' has no CAP with that cue id');
    else if (norm(c.text) !== norm(v.text)) add('voice', v.line, 'the VOICE line for ' + v.cue + ' differs from its CAP: voice "' + excerpt(v.text) + '", caption "' + excerpt(c.text) + '"');
  }
  if (p.voices.length === 0) return;
  for (const c of p.caps) if (!seen.has(c.cue)) add('voice', c.line, 'caption ' + c.cue + ' has no VOICE line while other captions have one');
}

// ---------- the claims lint on the words a viewer sees ----------

function ruleLint(p: Parsed, ctx: Ctx, scriptLabel: string): void {
  const lintPath = path.join(scriptDir, 'claims-lint.ts');
  if (!fs.existsSync(lintPath)) {
    noteMissing(shown(lintPath));
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-script-lint-'));
  try {
    const scratch = path.join(tmp, 'video-script.md');
    fs.writeFileSync(scratch, p.scratch.join('\n'));
    const args = [lintPath, '--file', scratch, '--docs', path.join(ctx.rootAbs, 'docs')];
    const markers = path.join(ctx.rootAbs, 'fixtures', 'payload-markers.txt');
    if (fs.existsSync(markers)) args.push('--markers', markers);
    const r = spawnSync(process.execPath, args, { cwd: tmp, encoding: 'utf8' });
    if (r.status === 0) return;
    const out = (r.stdout ?? '').split('\n').filter((l) => l !== '');
    const prefix = new RegExp('^FINDING (\\d+) ' + scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+) (.*)$');
    let parsed = 0;
    for (const l of out) {
      const m = prefix.exec(l);
      if (m === null) continue;
      parsed++;
      add('lint', Number(m[2]), (m[1] ?? '') + ' ' + (m[3] ?? ''));
    }
    if (r.status === null || r.status === 2 || parsed === 0) {
      const detail = out.filter((l) => !l.startsWith('FINDING ')).join('; ') || (r.error !== undefined ? String(r.error.message) : (r.stderr ?? '').split('\n')[0] ?? '');
      add('lint', 1, 'the claims lint exited ' + String(r.status) + ' on the scratch copy of ' + scriptLabel + ': ' + detail);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- main ----------

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    process.stderr.write('video-script-check: ' + args + '\nusage: video-script-check.ts [--draft] [--root <dir>] [--file <path>] [--json | --links] | --say F<nn>\n');
    return 2;
  }
  if (args.say !== null) return runSayMode(args.say);

  const defaultRoot = path.resolve(scriptDir, '..');
  const rootAbs = path.resolve(args.root ?? defaultRoot);
  const label = (rel: string): string => (args.root !== null ? path.join(args.root, rel) : shown(path.join(defaultRoot, rel)));
  const scriptLabel = args.file !== null ? args.file : label('docs/video-script.md');
  const scriptPath = args.file !== null ? args.file : path.join(rootAbs, 'docs', 'video-script.md');
  const ctx: Ctx = { rootAbs, label, cache: new Map() };

  let bytes: Buffer | null = null;
  try {
    if (fs.statSync(scriptPath).isFile()) bytes = fs.readFileSync(scriptPath);
  } catch {
    bytes = null;
  }
  const payload = args.json || args.links;
  if (bytes === null) {
    const line = 'INPUT MISSING ' + scriptLabel + '\n';
    if (payload) process.stderr.write(line);
    else process.stdout.write(line);
    return 2;
  }

  const p = parseScript(bytes.toString('utf8'));
  ruleDraft(p, args);
  ruleLock(p, bytes, args);
  const total = ruleShots(p);
  ruleCaptions(p);
  ruleSay(p);
  ruleNumber(p, ctx);
  ruleScreen(p, ctx);
  ruleScreenFmt(p, ctx);
  ruleWords(p, ctx);
  ruleVoice(p);
  ruleLint(p, ctx, scriptLabel);

  const order = [...findings].sort((a, b) => RULES.indexOf(a.rule) - RULES.indexOf(b.rule) || (a.file ?? '').localeCompare(b.file ?? '') || a.line - b.line || a.seq - b.seq);
  const report: string[] = [];
  for (const f of order) report.push('FINDING ' + f.rule + ' ' + (f.file ?? scriptLabel) + ':' + f.line + ' ' + f.text);
  let code = 0;
  if (missing.length > 0) {
    for (const m of missing) report.push('INPUT MISSING ' + m);
    code = 2;
  } else if (findings.length > 0) {
    report.push('VIDEO SCRIPT FAIL ' + findings.length + ' findings');
    code = 1;
  } else if (!payload) {
    const words = p.caps.reduce((n, c) => n + wordsOf(c.text).length, 0);
    report.push('VIDEO SCRIPT OK shots=' + p.shots.length + ' seconds=' + total + ' words=' + words);
  }

  if (args.json) {
    const shots = p.shots.map((s) => ({ shot: s.id, mode: s.mode, start: s.start, end: s.end }));
    const voiceOf = new Map<string, string>();
    for (const v of p.voices) if (!voiceOf.has(v.cue)) voiceOf.set(v.cue, v.text);
    const cues = p.caps.map((c) => ({ shot: c.shot.id, cue: c.cue, start: c.start, end: c.end, text: c.text, voice: voiceOf.get(c.cue) ?? null }));
    process.stdout.write(JSON.stringify({ seconds: total, shots, cues }, null, 2) + '\n');
  } else if (args.links) {
    const urls: string[] = [];
    for (const s of p.shots) for (const r of s.runs) for (const u of urlsIn(r.text)) if (!urls.includes(u)) urls.push(u);
    process.stdout.write(urls.map((u) => u + '\n').join(''));
  }
  if (payload) {
    if (report.length > 0) process.stderr.write(report.join('\n') + '\n');
  } else process.stdout.write(report.join('\n') + '\n');
  return code;
}

process.exitCode = main();

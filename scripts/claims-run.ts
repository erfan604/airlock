// Claims runner (AIR-240, tiers AIR-284). Runs the Command cell of every row of docs/CLAIMS.md, one row at a time, and says which rows pass.
//
// Usage: scripts/claims-run.sh [--offline | --network | --tier node|rust|full [--network]]
//        node scripts/claims-run.ts <same flags>     (Node 24, erasable TypeScript, standard library only)
//   --offline  (default) every row that needs no network: Needs none or a tool list. No tool is looked for: a missing tool is the
//              command's own failure
//   --network  only the rows with Needs network
//   --tier     every row, each one run or skipped: node runs Needs none and node, rust adds rust, full adds kani and lean. A row that
//              is outside the tier, or whose tool is not on the PATH (command -v), prints SKIP <id> needs <tool> (the first missing
//              tool in the order the cell lists them) and is not a failure. --network added to --tier runs the network rows too
// Needs: none (Node and pnpm only, counts as node), network, keys (listed, never run), or a comma separated list of node, rust, kani,
// lean. node needs the binaries node and pnpm, rust cargo, kani kani, lean lake.
//
// Output, one line per row:  PASS <id> <seconds>s | FAIL <id>: <reason> (then the tail of the output, indented) | PENDING <id> AIR-<nnn>
//   | SKIP <id> needs <tool>. A row fails when its command exits nonzero, when the Expected output substring is not in stdout or
// stderr, when `git status --porcelain` differs after the command from before it (a claim command must not write tracked files), or
// when its cells are unusable (unknown Needs, empty Command or Expected output, a pending: marker without a ticket id). A row whose
// Command cell starts with pending: AIR-<nnn> is never run.
// Last line: CLAIMS OFFLINE OK <n> rows | CLAIMS NETWORK OK <n> rows (n counts PASS rows; ` (<p> pending)` is appended when any row
//   is pending) | CLAIMS TIER <name> OK <n> run, <k> skipped (pending rows are in neither number) | CLAIMS <MODE> FAIL <f> failed.
// Exit 0 when no row failed, 1 otherwise, 2 for a usage error or a missing input (INPUT MISSING <what>).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOLS = ['node', 'rust', 'kani', 'lean'];
const TIERS: Record<string, string[]> = { node: ['node'], rust: ['node', 'rust'], full: ['node', 'rust', 'kani', 'lean'] };
// the binaries a Needs word asks for, and the name SKIP prints when one is missing
const BINS: Record<string, { bin: string; shown: string }[]> = {
  node: [{ bin: 'node', shown: 'node' }, { bin: 'pnpm', shown: 'pnpm' }],
  rust: [{ bin: 'cargo', shown: 'rust' }],
  kani: [{ bin: 'kani', shown: 'kani' }],
  lean: [{ bin: 'lake', shown: 'lean' }],
};
const TAIL_LINES = 12;

type Mode = { kind: 'offline' } | { kind: 'network' } | { kind: 'tier'; tier: string; network: boolean };
type Needs = { kind: 'none' | 'network' | 'keys' } | { kind: 'tools'; tools: string[] } | { kind: 'bad'; text: string };
type Row = { id: string; command: string; expected: string; needs: Needs; pending: boolean; ticket: string; markerBad: boolean };

const root = path.join(path.dirname(fs.realpathSync(process.argv[1] ?? '.')), '..');

function out(line: string): void {
  try {
    fs.writeSync(1, line + '\n');
  } catch {
    process.stdout.write(line + '\n');
  }
}

// ---------- arguments ----------

function parseArgs(argv: string[]): Mode | string {
  let offline = false;
  let network = false;
  let tier: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i] ?? '';
    i++;
    if (flag === '--offline') offline = true;
    else if (flag === '--network') network = true;
    else if (flag === '--tier') {
      const v = argv[i];
      if (v === undefined) return '--tier needs a value (node, rust or full)';
      i++;
      if (TIERS[v] === undefined) return 'unknown tier ' + v + ' (node, rust or full)';
      tier = v;
    } else return 'unknown argument ' + flag;
  }
  if (tier !== null) return offline ? '--offline and --tier exclude each other' : { kind: 'tier', tier, network };
  if (offline && network) return '--offline and --network exclude each other';
  return network ? { kind: 'network' } : { kind: 'offline' };
}

// ---------- reading CLAIMS.md ----------

// The lines of a markdown text outside fenced code blocks and HTML comments.
function visibleLines(text: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let inComment = false;
  for (const raw of text.split(/\r?\n/)) {
    if (fence !== null) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(raw);
      if (close !== null && (close[1] ?? '')[0] === fence[0] && (close[1] ?? '').length >= fence.length) fence = null;
      out.push('');
      continue;
    }
    if (!inComment) {
      const open = /^\s*(`{3,}|~{3,})/.exec(raw);
      if (open !== null) {
        fence = open[1] ?? '```';
        out.push('');
        continue;
      }
    }
    let rest = raw;
    let vis = '';
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end < 0) rest = '';
        else {
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
    out.push(vis);
  }
  return out;
}

function isDelimiter(s: string): boolean {
  return s.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
}

function splitRow(s: string): string[] {
  let t = s.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

// A Command or Expected cell: the pipes unescaped, one pair of backticks around the whole cell removed.
function cellValue(cell: string): string {
  let v = cell.replace(/\\\|/g, '|').trim();
  const m = /^(`+)([\s\S]*)\1$/.exec(v);
  if (m !== null) v = (m[2] ?? '').trim();
  return v;
}

// the same reading as rule 1 of claims-lint.ts
function parseNeeds(cell: string): Needs {
  const v = cell.trim();
  if (v === 'none' || v === 'network' || v === 'keys') return { kind: v };
  const parts = v.split(',').map((p) => p.trim());
  if (parts.every((p) => TOOLS.includes(p))) return { kind: 'tools', tools: parts };
  return { kind: 'bad', text: v };
}

// Rows of every table whose header has a Command column and whose first cell is an id like C1 or C1a.
function readRows(text: string): Row[] {
  const lines = visibleLines(text);
  const rows: Row[] = [];
  let cols: { command: number; expected: number; needs: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i] ?? '';
    if (!/^\s*\|/.test(s)) {
      cols = null;
      continue;
    }
    if (cols === null) {
      if (isDelimiter(lines[i + 1] ?? '')) {
        const h = splitRow(s).map((c) => c.toLowerCase());
        const command = h.indexOf('command');
        if (command >= 0) cols = { command, expected: h.indexOf('expected output'), needs: h.indexOf('needs') };
        i++;
      }
      continue;
    }
    const cells = splitRow(s);
    const id = cells[0] ?? '';
    if (!/^C\d+[a-z]?$/.test(id)) continue;
    const command = cellValue(cells[cols.command] ?? '');
    let pending = false;
    let ticket = '';
    let markerBad = false;
    if (command.startsWith('pending:')) {
      const m = /^pending: (AIR-\d+)(?:\s|$)/.exec(command);
      if (m === null) markerBad = true;
      else {
        pending = true;
        ticket = m[1] ?? '';
      }
    }
    rows.push({
      id,
      command,
      expected: cols.expected < 0 ? '' : cellValue(cells[cols.expected] ?? ''),
      needs: cols.needs < 0 ? { kind: 'bad', text: '' } : parseNeeds(cells[cols.needs] ?? ''),
      pending,
      ticket,
      markerBad,
    });
  }
  return rows;
}

// ---------- running one row ----------

function onPath(bin: string): boolean {
  return spawnSync('/bin/sh', ['-c', 'command -v "$1" > /dev/null 2>&1', 'sh', bin]).status === 0;
}

function gitStatus(): string | null {
  const p = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return p.status === 0 ? p.stdout : null;
}

function statusDiff(before: string, after: string): string {
  const a = new Set(before.split('\n').filter((l) => l !== ''));
  const b = new Set(after.split('\n').filter((l) => l !== ''));
  const gone = [...a].filter((l) => !b.has(l)).map((l) => '-' + l);
  const added = [...b].filter((l) => !a.has(l)).map((l) => '+' + l);
  return [...added, ...gone].slice(0, 4).join(', ');
}

function tailOf(text: string): string[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-TAIL_LINES).map((l) => '  ' + (l.length > 200 ? l.slice(0, 197) + '...' : l));
}

// Runs the command; returns the reasons it fails (empty when it passes) with the seconds and the tail of the output.
function execute(row: Row): { reasons: string[]; seconds: number; tail: string[] } {
  const before = gitStatus() ?? '';
  const t0 = Date.now();
  const p = spawnSync('/bin/sh', ['-c', row.command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 29 });
  const seconds = Math.round((Date.now() - t0) / 1000);
  const output = (p.stdout ?? '') + (p.stderr ?? '');
  const reasons: string[] = [];
  if (p.status === null) reasons.push('the command did not finish (' + (p.error !== undefined ? p.error.message : 'signal ' + String(p.signal)) + ')');
  else if (p.status !== 0) reasons.push('the command exited ' + p.status);
  if (!output.includes(row.expected)) reasons.push('expected output "' + row.expected + '" is not in the output');
  const after = gitStatus() ?? '';
  if (after !== before) reasons.push('the tree changed (git status --porcelain: ' + statusDiff(before, after) + ')');
  return { reasons, seconds, tail: reasons.length > 0 ? tailOf(output) : [] };
}

// The first tool of the row that the tier excludes or the PATH lacks, or null when the row can run.
function missingTool(tools: string[], tier: string): string | null {
  for (const t of tools) {
    if (!(TIERS[tier] ?? []).includes(t)) return t;
    for (const b of BINS[t] ?? []) if (!onPath(b.bin)) return b.shown;
  }
  return null;
}

// ---------- main ----------

function main(): number {
  const mode = parseArgs(process.argv.slice(2));
  if (typeof mode === 'string') {
    process.stderr.write('claims-run: ' + mode + '\nusage: claims-run.sh [--offline | --network | --tier node|rust|full [--network]]\n');
    return 2;
  }
  const claimsPath = path.join(root, 'docs', 'CLAIMS.md');
  let text: string;
  try {
    text = fs.readFileSync(claimsPath, 'utf8');
  } catch {
    out('INPUT MISSING docs/CLAIMS.md');
    return 2;
  }
  if (gitStatus() === null) {
    out('INPUT MISSING git work tree (git status failed in ' + root + ')');
    return 2;
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let pending = 0;
  const fail = (row: Row, reason: string, tail: string[] = []): void => {
    failed++;
    out('FAIL ' + row.id + ': ' + reason);
    for (const l of tail) out(l);
  };
  const skip = (row: Row, what: string): void => {
    skipped++;
    out('SKIP ' + row.id + ' needs ' + what);
  };

  for (const row of readRows(text)) {
    const kind = row.needs.kind;
    // does this mode look at the row at all (a pending row is shown only by the mode that selects it, keys rows by every mode)
    const selected = mode.kind === 'tier' || kind === 'keys' || (mode.kind === 'network' ? kind === 'network' : kind !== 'network');
    if (!selected) continue;
    if (row.pending) {
      pending++;
      out('PENDING ' + row.id + ' ' + row.ticket);
      continue;
    }
    if (row.markerBad) {
      fail(row, 'the Command cell starts with pending: but has no ticket id (write pending: AIR-<nnn> and then the command)');
      continue;
    }
    if (row.needs.kind === 'bad') {
      fail(row, 'unknown Needs value "' + row.needs.text + '" (none, network, keys, or a list of node, rust, kani, lean)');
      continue;
    }
    if (kind === 'keys') {
      skip(row, 'keys');
      continue;
    }
    if (mode.kind === 'tier') {
      if (kind === 'network') {
        if (!mode.network) {
          skip(row, 'network');
          continue;
        }
      } else {
        const missing = missingTool(row.needs.kind === 'tools' ? row.needs.tools : ['node'], mode.tier);
        if (missing !== null) {
          skip(row, missing);
          continue;
        }
      }
    }
    if (row.command === '') {
      fail(row, 'the Command cell is empty');
      continue;
    }
    if (row.expected === '') {
      fail(row, 'the Expected output cell is empty');
      continue;
    }
    const r = execute(row);
    if (r.reasons.length > 0) fail(row, r.reasons.join('; '), r.tail);
    else {
      passed++;
      out('PASS ' + row.id + ' ' + r.seconds + 's');
    }
  }

  const name = mode.kind === 'tier' ? 'TIER ' + mode.tier : mode.kind.toUpperCase();
  if (failed > 0) out('CLAIMS ' + name + ' FAIL ' + failed + ' failed');
  else if (mode.kind === 'tier') out('CLAIMS ' + name + ' OK ' + passed + ' run, ' + skipped + ' skipped');
  else out('CLAIMS ' + name + ' OK ' + passed + ' rows' + (pending > 0 ? ' (' + pending + ' pending)' : ''));
  return failed > 0 ? 1 : 0;
}

process.exitCode = main();

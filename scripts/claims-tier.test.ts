// Tests for the tier flag of scripts/claims-run.ts and for the Needs values of scripts/claims-lint.ts rule 1 (AIR-284).
// Run: node --test scripts/claims-tier.test.ts (Node 24) or pnpm tsx --test. The runner without a tier is tested in claims-run.test.ts.
// Each runner test builds a scratch git repo (a copy of the runner, a docs/CLAIMS.md with the rows of the test, `git add`, no commit,
// no git config). A tool is made present or missing by giving the runner a PATH that holds only stub executables and git, so the
// outcome never depends on what is installed on this machine; the runner itself is started by its absolute path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'claims-run.ts');
const LINT = path.join(HERE, 'claims-lint.ts');
const LISTS_DIR = path.join(HERE, '..', 'docs');
const FIXTURE = path.join(HERE, 'fixtures', 'claims-lint', 'pass');
const HEADER = '| # | Claim | Evidence (file:line) | Command | Expected output | Needs | Source ticket |\n| --- | --- | --- | --- | --- | --- | --- |\n';

type Row = { id: string; command: string; expected: string; needs: string };
type Result = { code: number | null; lines: string[]; last: string; err: string };

function row(id: string, needs: string, command = 'echo ' + id, expected = id): Row {
  return { id, command, expected, needs };
}

function table(rows: Row[]): string {
  const bt = (s: string): string => (s === '' ? '' : '`' + s + '`');
  return '# Claims\n\n' + HEADER + rows.map((r) => '| ' + r.id + ' | A claim. |  | ' + bt(r.command) + ' | ' + bt(r.expected) + ' | ' + r.needs + ' | AIR-284 |').join('\n') + '\n';
}

// the rows most tests share: one per Needs value, a pending row and a combined list
const ROWS: Row[] = [
  row('C1', 'none'),
  row('C2', 'node'),
  row('C3', 'rust'),
  row('C4', 'kani'),
  row('C5', 'lean'),
  row('C6', 'rust,lean'),
  row('C7', 'network'),
  row('C8', 'keys'),
  { id: 'C9', command: 'pending: AIR-228 echo C9', expected: 'C9', needs: 'rust' },
];

function realGit(): string {
  return (spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout ?? '').trim();
}

// A directory that holds git and one stub executable per tool name, for use as the whole PATH of the runner.
function stubBin(tools: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-tier-bin-'));
  fs.symlinkSync(realGit(), path.join(d, 'git'));
  for (const t of tools) fs.writeFileSync(path.join(d, t), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return d;
}

const ALL_TOOLS = ['node', 'pnpm', 'cargo', 'kani', 'lake'];

function withRepo(text: string, fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-tier-test-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.copyFileSync(RUNNER, path.join(root, 'scripts', 'claims-run.ts'));
    fs.writeFileSync(path.join(root, 'docs', 'CLAIMS.md'), text);
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: root }).status, 0);
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Run the runner with a PATH made of the stubs for the given tools.
function runWith(root: string, tools: string[], args: string[]): Result {
  const bin = stubBin(tools);
  try {
    const p = spawnSync(process.execPath, [path.join(root, 'scripts', 'claims-run.ts'), ...args], { cwd: root, encoding: 'utf8', env: { PATH: bin } });
    const lines = (p.stdout ?? '').split('\n').filter((l) => l !== '');
    return { code: p.status, lines, last: lines[lines.length - 1] ?? '', err: p.stderr ?? '' };
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

function dump(res: Result): string {
  return res.lines.join('\n') + '\n' + res.err;
}

function line(res: Result, prefix: string): string[] {
  return res.lines.filter((l) => l.startsWith(prefix));
}

// ---------- tier selection ----------

test('--tier node runs the none and node rows and skips the rows above the tier with the first tool they need', () => {
  withRepo(table(ROWS), (root) => {
    const res = runWith(root, ALL_TOOLS, ['--tier', 'node']);
    assert.equal(res.code, 0, dump(res));
    assert.deepEqual(line(res, 'PASS ').map((l) => l.split(' ')[1]), ['C1', 'C2']);
    assert.deepEqual(line(res, 'SKIP '), ['SKIP C3 needs rust', 'SKIP C4 needs kani', 'SKIP C5 needs lean', 'SKIP C6 needs rust', 'SKIP C7 needs network', 'SKIP C8 needs keys']);
    assert.deepEqual(line(res, 'PENDING '), ['PENDING C9 AIR-228']);
    assert.equal(res.last, 'CLAIMS TIER node OK 2 run, 6 skipped');
  });
});

test('--tier rust adds the rust rows, a row that lists rust and lean waits for lean', () => {
  withRepo(table(ROWS), (root) => {
    const res = runWith(root, ALL_TOOLS, ['--tier', 'rust']);
    assert.equal(res.code, 0, dump(res));
    assert.deepEqual(line(res, 'PASS ').map((l) => l.split(' ')[1]), ['C1', 'C2', 'C3']);
    assert.deepEqual(line(res, 'SKIP '), ['SKIP C4 needs kani', 'SKIP C5 needs lean', 'SKIP C6 needs lean', 'SKIP C7 needs network', 'SKIP C8 needs keys']);
    assert.equal(res.last, 'CLAIMS TIER rust OK 3 run, 5 skipped');
  });
});

test('--tier full runs every tool row, --network adds the network rows, keys rows are never run', () => {
  withRepo(table(ROWS), (root) => {
    const full = runWith(root, ALL_TOOLS, ['--tier', 'full']);
    assert.equal(full.code, 0, dump(full));
    assert.deepEqual(line(full, 'PASS ').map((l) => l.split(' ')[1]), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
    assert.deepEqual(line(full, 'SKIP '), ['SKIP C7 needs network', 'SKIP C8 needs keys']);
    assert.equal(full.last, 'CLAIMS TIER full OK 6 run, 2 skipped');
    const net = runWith(root, ALL_TOOLS, ['--tier', 'full', '--network']);
    assert.equal(net.code, 0, dump(net));
    assert.deepEqual(line(net, 'PASS ').map((l) => l.split(' ')[1]), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
    assert.deepEqual(line(net, 'SKIP '), ['SKIP C8 needs keys']);
    assert.equal(net.last, 'CLAIMS TIER full OK 7 run, 1 skipped');
  });
});

test('--tier node --network runs the network rows without any other tier change', () => {
  withRepo(table(ROWS), (root) => {
    const res = runWith(root, ALL_TOOLS, ['--network', '--tier', 'node']);
    assert.deepEqual(line(res, 'PASS ').map((l) => l.split(' ')[1]), ['C1', 'C2', 'C7']);
    assert.equal(res.last, 'CLAIMS TIER node OK 3 run, 5 skipped');
  });
});

test('pending rows are in neither the run count nor the skipped count', () => {
  withRepo(table([row('C1', 'none'), { id: 'C2', command: 'pending: AIR-030 echo x', expected: 'x', needs: 'lean' }]), (root) => {
    const res = runWith(root, ALL_TOOLS, ['--tier', 'full']);
    assert.deepEqual(line(res, 'PENDING '), ['PENDING C2 AIR-030']);
    assert.equal(res.last, 'CLAIMS TIER full OK 1 run, 0 skipped');
  });
});

// ---------- a tool missing from the PATH ----------

test('a machine with only node and pnpm sees SKIP for the rows that need cargo, kani or lake, never FAIL', () => {
  withRepo(table(ROWS), (root) => {
    const res = runWith(root, ['node', 'pnpm'], ['--tier', 'full']);
    assert.equal(res.code, 0, dump(res));
    assert.deepEqual(line(res, 'PASS ').map((l) => l.split(' ')[1]), ['C1', 'C2']);
    assert.deepEqual(line(res, 'SKIP '), ['SKIP C3 needs rust', 'SKIP C4 needs kani', 'SKIP C5 needs lean', 'SKIP C6 needs rust', 'SKIP C7 needs network', 'SKIP C8 needs keys']);
    assert.ok(line(res, 'FAIL ').length === 0);
    assert.equal(res.last, 'CLAIMS TIER full OK 2 run, 6 skipped');
  });
});

test('spaces after the commas of a Needs list do not matter', () => {
  withRepo(table([row('C1', 'rust, lean'), row('C2', 'node, rust, kani, lean')]), (root) => {
    const res = runWith(root, ALL_TOOLS, ['--tier', 'full']);
    assert.equal(res.code, 0, dump(res));
    assert.deepEqual(line(res, 'PASS ').map((l) => l.split(' ')[1]), ['C1', 'C2']);
    const lacking = runWith(root, ['node', 'pnpm', 'cargo'], ['--tier', 'full']);
    assert.deepEqual(line(lacking, 'SKIP '), ['SKIP C1 needs lean', 'SKIP C2 needs kani']);
  });
});

test('the skipped command is never run', () => {
  withRepo(table([row('C4', 'kani', 'echo ran > ran.txt; echo C4', 'C4')]), (root) => {
    const res = runWith(root, ['node', 'pnpm'], ['--tier', 'full']);
    assert.deepEqual(line(res, 'SKIP '), ['SKIP C4 needs kani']);
    assert.ok(!fs.existsSync(path.join(root, 'ran.txt')));
  });
});

test('the first missing tool in the order of the cell is the one named', () => {
  withRepo(table([row('C6', 'rust,lean'), row('C7', 'lean,rust')]), (root) => {
    const onlyCargo = runWith(root, ['cargo'], ['--tier', 'full']);
    assert.deepEqual(line(onlyCargo, 'SKIP '), ['SKIP C6 needs lean', 'SKIP C7 needs lean']);
    const none = runWith(root, [], ['--tier', 'full']);
    assert.deepEqual(line(none, 'SKIP '), ['SKIP C6 needs rust', 'SKIP C7 needs lean']);
  });
});

test('the tier is checked before the PATH: a row above the tier is skipped with the tool present', () => {
  withRepo(table([row('C5', 'lean')]), (root) => {
    const res = runWith(root, ALL_TOOLS, ['--tier', 'rust']);
    assert.deepEqual(line(res, 'SKIP '), ['SKIP C5 needs lean']);
    assert.equal(res.last, 'CLAIMS TIER rust OK 0 run, 1 skipped');
  });
});

test('none counts as node: both need node and pnpm, and both are skipped with the same tool when pnpm is missing', () => {
  withRepo(table([row('C1', 'none'), row('C2', 'node')]), (root) => {
    const noPnpm = runWith(root, ['node'], ['--tier', 'node']);
    assert.deepEqual(line(noPnpm, 'SKIP '), ['SKIP C1 needs pnpm', 'SKIP C2 needs pnpm']);
    const noNode = runWith(root, ['pnpm'], ['--tier', 'node']);
    assert.deepEqual(line(noNode, 'SKIP '), ['SKIP C1 needs node', 'SKIP C2 needs node']);
    const both = runWith(root, ['node', 'pnpm'], ['--tier', 'node']);
    assert.deepEqual(line(both, 'PASS ').map((l) => l.split(' ')[1]), ['C1', 'C2']);
  });
});

// ---------- FAIL with the tool present ----------

test('a failing row whose tool is present is a FAIL with its reason, exit 1', () => {
  withRepo(table([row('C4', 'kani', 'echo nope', 'yes'), row('C1', 'none')]), (root) => {
    const res = runWith(root, ALL_TOOLS, ['--tier', 'full']);
    assert.equal(res.code, 1, dump(res));
    assert.match(line(res, 'FAIL ')[0] ?? '', /^FAIL C4: .*yes/);
    assert.ok(line(res, 'PASS ').some((l) => l.startsWith('PASS C1 ')), 'later rows still run');
    assert.equal(res.last, 'CLAIMS TIER full FAIL 1 failed');
  });
});

test('the same failing row is a SKIP, not a FAIL, when its tool is missing', () => {
  withRepo(table([row('C4', 'kani', 'echo nope', 'yes')]), (root) => {
    const res = runWith(root, ['node', 'pnpm'], ['--tier', 'full']);
    assert.equal(res.code, 0, dump(res));
    assert.deepEqual(line(res, 'SKIP '), ['SKIP C4 needs kani']);
  });
});

test('a row with an unknown Needs value is a FAIL in tier mode and is not run', () => {
  withRepo(table([row('C1', 'gpu', 'echo ran > ran.txt; echo C1', 'C1')]), (root) => {
    const res = runWith(root, ALL_TOOLS, ['--tier', 'full']);
    assert.equal(res.code, 1, dump(res));
    assert.match(line(res, 'FAIL ')[0] ?? '', /^FAIL C1: .*gpu/);
    assert.ok(!fs.existsSync(path.join(root, 'ran.txt')));
  });
});

// ---------- --offline and --network are unchanged ----------

test('--offline runs the rows that list tools without looking for them, --network runs only the network rows', () => {
  withRepo(table(ROWS), (root) => {
    const off = runWith(root, [], ['--offline']);
    assert.equal(off.code, 0, dump(off));
    assert.deepEqual(line(off, 'PASS ').map((l) => l.split(' ')[1]), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
    assert.equal(off.last, 'CLAIMS OFFLINE OK 6 rows (1 pending)');
    const net = runWith(root, [], ['--network']);
    assert.deepEqual(line(net, 'PASS ').map((l) => l.split(' ')[1]), ['C7']);
    assert.equal(net.last, 'CLAIMS NETWORK OK 1 rows');
  });
});

test('--tier cannot be combined with --offline and takes only node, rust or full', () => {
  withRepo(table(ROWS), (root) => {
    for (const args of [['--tier', 'node', '--offline'], ['--tier', 'all'], ['--tier', 'kani']]) {
      assert.equal(runWith(root, ALL_TOOLS, args).code, 2, args.join(' '));
    }
  });
});

// ---------- the lint accepts the new Needs values and rejects any other (rule 1) ----------

function withLint(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-tier-lint-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(LINT, path.join(root, 'scripts', 'claims-lint.ts'));
    fs.mkdirSync(path.join(root, 'docs'));
    for (const f of ['claim-verbs.txt', 'banned-phrases.txt', 'numbers-allowlist.txt']) fs.copyFileSync(path.join(LISTS_DIR, f), path.join(root, 'docs', f));
    fs.cpSync(FIXTURE, path.join(root, 'pass'), { recursive: true });
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function lintWithNeeds(root: string, needs: string): Result {
  const p = path.join(root, 'pass', 'docs', 'CLAIMS.md');
  const text = fs.readFileSync(p, 'utf8').replace('| none | AIR-030 |', '| ' + needs + ' | AIR-030 |');
  assert.ok(text.includes('| ' + needs + ' | AIR-030 |'));
  fs.writeFileSync(p, text);
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'claims-lint.ts'), '--readme', 'pass/README.md', '--docs', 'pass/docs'], { cwd: root, encoding: 'utf8' });
  const lines = (r.stdout ?? '').split('\n').filter((l) => l !== '');
  return { code: r.status, lines, last: lines[lines.length - 1] ?? '', err: r.stderr ?? '' };
}

test('lint rule 1 accepts none, network, keys, each tool word and comma separated lists of tool words', () => {
  for (const needs of ['none', 'network', 'keys', 'node', 'rust', 'kani', 'lean', 'rust,lean', 'node, rust, kani, lean', 'lean,rust']) {
    withLint((root) => {
      const res = lintWithNeeds(root, needs);
      assert.equal(res.code, 0, 'Needs ' + needs + ' was refused:\n' + dump(res));
      assert.ok(line(res, 'FINDING 1 ').length === 0);
    });
  }
});

test('lint rule 1 rejects any other Needs value with a finding on the CLAIMS row', () => {
  for (const needs of ['gpu', 'none,rust', 'rust,none', 'network,node', 'keys,rust', 'Rust', 'rust;lean', 'rust,,lean', 'rust,', ',rust', 'none and network', '`none`', 'cargo']) {
    withLint((root) => {
      const res = lintWithNeeds(root, needs);
      assert.equal(res.code, 1, 'Needs "' + needs + '" was accepted:\n' + dump(res));
      assert.match(line(res, 'FINDING 1 ')[0] ?? '', /^FINDING 1 pass\/docs\/CLAIMS\.md:\d+ .*C1a.*Needs/, needs);
      assert.match(res.last, /^CLAIMS LINT FAIL \d+ findings$/);
    });
  }
});

test('lint rule 1 rejects an empty Needs cell and checks rows that no README tag names', () => {
  withLint((root) => {
    const res = lintWithNeeds(root, '');
    assert.equal(res.code, 1, dump(res));
    assert.ok(line(res, 'FINDING 1 ').length > 0);
  });
  withLint((root) => {
    const p = path.join(root, 'pass', 'docs', 'CLAIMS.md');
    fs.appendFileSync(p, '| C77 | An unreferenced row. |  | `echo a` | `a` | gpu | AIR-284 |\n');
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'claims-lint.ts'), '--readme', 'pass/README.md', '--docs', 'pass/docs'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /FINDING 1 pass\/docs\/CLAIMS\.md:\d+ .*C77.*gpu/);
  });
});

test('the Needs check does not run in file mode', () => {
  withLint((root) => {
    const p = path.join(root, 'pass', 'docs', 'CLAIMS.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('| none | AIR-030 |', '| gpu | AIR-030 |'));
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'claims-lint.ts'), '--file', path.join('pass', 'docs', 'CLAIMS.md'), '--docs', 'pass/docs'], { cwd: root, encoding: 'utf8' });
    assert.ok(!/FINDING 1 /.test(r.stdout), r.stdout);
  });
});

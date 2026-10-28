// Tests for scripts/claims-run.ts and scripts/claims-run.sh (AIR-240). Run: node --test scripts/claims-run.test.ts (Node 24) or pnpm tsx --test.
// Every test builds a scratch git repo in a temp folder: a copy of the runner, a docs/CLAIMS.md with the rows of the test, and a
// `git add` of everything (no commit and no git config: git status --porcelain reads the index), so no test touches the real tree.
// The tier flag (AIR-284) has its own tests in claims-tier.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'claims-run.ts');
const WRAPPER = path.join(HERE, 'claims-run.sh');
const HEADER = '| # | Claim | Evidence (file:line) | Command | Expected output | Needs | Source ticket |\n| --- | --- | --- | --- | --- | --- | --- |\n';

type Row = { id: string; command: string; expected: string; needs?: string };
type Result = { code: number | null; lines: string[]; last: string; err: string };

// One table row. Command and Expected are wrapped in one pair of backticks each unless empty; a pipe inside them is written \| by the caller.
function rowLine(r: Row): string {
  const bt = (s: string): string => (s === '' ? '' : '`' + s + '`');
  return '| ' + r.id + ' | A claim. |  | ' + bt(r.command) + ' | ' + bt(r.expected) + ' | ' + (r.needs ?? 'none') + ' | AIR-240 |';
}

function claimsText(rows: Row[]): string {
  return '# Claims\n\nSome prose.\n\n' + HEADER + rows.map(rowLine).join('\n') + (rows.length > 0 ? '\n' : '');
}

type Repo = { root: string };

function withRepo(text: string, files: Record<string, string>, fn: (r: Repo) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-run-test-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.copyFileSync(RUNNER, path.join(root, 'scripts', 'claims-run.ts'));
    fs.copyFileSync(WRAPPER, path.join(root, 'scripts', 'claims-run.sh'));
    fs.writeFileSync(path.join(root, 'docs', 'CLAIMS.md'), text);
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), body);
    }
    const git = spawnSync('git', ['init', '-q'], { cwd: root });
    assert.equal(git.status, 0, 'git init failed');
    const add = spawnSync('git', ['add', '-A'], { cwd: root });
    assert.equal(add.status, 0, 'git add failed');
    fn({ root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withRows(rows: Row[], fn: (r: Repo) => void, files: Record<string, string> = {}): void {
  withRepo(claimsText(rows), files, fn);
}

function split(p: { status: number | null; stdout: string | null; stderr: string | null }): Result {
  const lines = (p.stdout ?? '').split('\n').filter((l) => l !== '');
  return { code: p.status, lines, last: lines[lines.length - 1] ?? '', err: p.stderr ?? '' };
}

function run(r: Repo, args: string[], env: NodeJS.ProcessEnv = process.env): Result {
  return split(spawnSync(process.execPath, [path.join(r.root, 'scripts', 'claims-run.ts'), ...args], { cwd: r.root, encoding: 'utf8', env }));
}

function has(res: Result, re: RegExp): boolean {
  return res.lines.some((l) => re.test(l));
}

function dump(res: Result): string {
  return res.lines.join('\n') + '\n' + res.err;
}

// ---------- PASS and FAIL ----------

test('a passing row prints PASS <id> <seconds>s and the last line counts it', () => {
  withRows([{ id: 'C1', command: 'echo hello world', expected: 'hello' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
    assert.ok(has(res, /^PASS C1 \d+s$/), dump(res));
    assert.equal(res.last, 'CLAIMS OFFLINE OK 1 rows');
  });
});

test('the seconds on a PASS line are the wall time of the command', () => {
  withRows([{ id: 'C1', command: 'sleep 1; echo ok', expected: 'ok' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
    assert.ok(has(res, /^PASS C1 [1-9]s$/), dump(res));
  });
});

test('text on stderr counts as output', () => {
  withRows([{ id: 'C1', command: 'echo oops 1>&2', expected: 'oops' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
    assert.ok(has(res, /^PASS C1 /));
  });
});

test('a wrong expected substring is a FAIL with its reason, exit 1, and no OK line', () => {
  withRows([{ id: 'C1', command: 'echo hello', expected: 'goodbye' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 1, dump(res));
    const fail = res.lines.find((l) => l.startsWith('FAIL C1: ')) ?? '';
    assert.match(fail, /goodbye/);
    assert.equal(res.last, 'CLAIMS OFFLINE FAIL 1 failed');
    assert.ok(!has(res, /^PASS /));
  });
});

test('a command that edits a tracked file is a FAIL because the tree changed', () => {
  withRows([{ id: 'C1', command: 'echo b > tracked.txt; echo done', expected: 'done' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 1, dump(res));
    const fail = res.lines.find((l) => l.startsWith('FAIL C1: ')) ?? '';
    assert.match(fail, /tree changed/);
    assert.match(fail, /tracked\.txt/);
    assert.equal(res.last, 'CLAIMS OFFLINE FAIL 1 failed');
  }, { 'tracked.txt': 'a\n' });
});

test('a command that creates an untracked file is a FAIL because the tree changed', () => {
  withRows([{ id: 'C1', command: 'echo x > new.txt; echo done', expected: 'done' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 1, dump(res));
    assert.match(res.lines.find((l) => l.startsWith('FAIL C1: ')) ?? '', /tree changed.*new\.txt/);
  });
});

test('a command that only reads passes even when the tree was already dirty', () => {
  withRows([{ id: 'C1', command: 'cat tracked.txt', expected: 'a' }], (r) => {
    fs.writeFileSync(path.join(r.root, 'untracked-before.txt'), 'x\n');
    fs.writeFileSync(path.join(r.root, 'tracked.txt'), 'a changed\n');
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
    assert.ok(has(res, /^PASS C1 /));
  }, { 'tracked.txt': 'a\n' });
});

test('a command that exits nonzero is a FAIL even when it printed the expected text', () => {
  withRows([{ id: 'C1', command: 'echo hello; exit 3', expected: 'hello' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 1, dump(res));
    assert.match(res.lines.find((l) => l.startsWith('FAIL C1: ')) ?? '', /exited 3/);
  });
});

test('a FAIL shows the tail of the output and does not stop the later rows', () => {
  withRows([
    { id: 'C1', command: 'echo visible-tail-line', expected: 'nope' },
    { id: 'C2', command: 'echo fine', expected: 'fine' },
  ], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 1, dump(res));
    assert.ok(has(res, /^ {2}.*visible-tail-line/), dump(res));
    assert.ok(has(res, /^PASS C2 /), dump(res));
    assert.equal(res.last, 'CLAIMS OFFLINE FAIL 1 failed');
  });
});

test('rows run once each in file order and only rows with an id like C1 or C1a are read', () => {
  withRepo(
    '# Claims\n\n' + HEADER + rowLine({ id: 'C1b', command: 'echo one', expected: 'one' }) + '\n' + rowLine({ id: 'C1a', command: 'echo two', expected: 'two' }) + '\n' +
      '| H1 | A harness row | | `echo three` | `three` | none | AIR-028 |\n\n| Other | table |\n| --- | --- |\n| C3 | not a claims table |\n',
    {},
    (r) => {
      const res = run(r, ['--offline']);
      assert.equal(res.code, 0, dump(res));
      assert.deepEqual(res.lines.filter((l) => l.startsWith('PASS ')).map((l) => l.split(' ')[1]), ['C1b', 'C1a'], dump(res));
      assert.equal(res.last, 'CLAIMS OFFLINE OK 2 rows');
    },
  );
});

test('a table row inside a fenced block or an HTML comment is not read', () => {
  const fenced = '```\n' + HEADER + rowLine({ id: 'C8', command: 'echo no', expected: 'no' }) + '\n```\n';
  const commented = '<!--\n' + HEADER + rowLine({ id: 'C9', command: 'echo no', expected: 'no' }) + '\n-->\n';
  withRepo('# Claims\n\n' + fenced + commented + HEADER + rowLine({ id: 'C1', command: 'echo yes', expected: 'yes' }) + '\n', {}, (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
    assert.equal(res.lines.filter((l) => l.startsWith('PASS ')).length, 1, dump(res));
    assert.equal(res.last, 'CLAIMS OFFLINE OK 1 rows');
  });
});

// ---------- the Command and Expected cells ----------

test('an escaped pipe in a Command cell is unescaped before the command runs', () => {
  withRows([{ id: 'C1', command: 'echo abc \\| tr a x', expected: 'xbc' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
    assert.ok(has(res, /^PASS C1 /));
  });
});

test('an escaped pipe in an Expected cell is unescaped before the search', () => {
  withRows([{ id: 'C1', command: "echo 'a\\|b'", expected: 'a\\|b' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
    assert.ok(has(res, /^PASS C1 /));
  });
});

test('an empty Command cell or an empty Expected cell is a FAIL and nothing runs', () => {
  withRows([{ id: 'C1', command: '', expected: 'x' }, { id: 'C2', command: 'echo ran > ran.txt', expected: '' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 1, dump(res));
    assert.match(res.lines.find((l) => l.startsWith('FAIL C1: ')) ?? '', /Command/);
    assert.match(res.lines.find((l) => l.startsWith('FAIL C2: ')) ?? '', /Expected/);
    assert.ok(!fs.existsSync(path.join(r.root, 'ran.txt')));
    assert.equal(res.last, 'CLAIMS OFFLINE FAIL 2 failed');
  });
});

test('an unknown Needs value is a FAIL that names it and the command is not run', () => {
  withRows([{ id: 'C1', command: 'echo ran > ran.txt; echo x', expected: 'x', needs: 'gpu' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 1, dump(res));
    assert.match(res.lines.find((l) => l.startsWith('FAIL C1: ')) ?? '', /gpu/);
    assert.ok(!fs.existsSync(path.join(r.root, 'ran.txt')));
  });
});

test('a Needs list with one bad word among good ones is an unknown value', () => {
  withRows([{ id: 'C1', command: 'echo ran > ran.txt; echo x', expected: 'x', needs: 'rust,gpu' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 1, dump(res));
    assert.match(res.lines.find((l) => l.startsWith('FAIL C1: ')) ?? '', /rust,gpu/);
    assert.ok(!fs.existsSync(path.join(r.root, 'ran.txt')));
  });
});

test('a command that is killed by a signal is a FAIL even when it printed the expected text', () => {
  withRows([{ id: 'C1', command: 'echo hello; kill -9 $$', expected: 'hello' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 1, dump(res));
    assert.match(res.lines.find((l) => l.startsWith('FAIL C1: ')) ?? '', /did not finish.*SIGKILL/);
  });
});

test('a command with a lot of output is read to the end', () => {
  withRows([{ id: 'C1', command: "awk 'BEGIN { for (i = 0; i < 40000; i++) print \"xxxxxxxxxx\"; print \"the-end\" }'", expected: 'the-end' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
  });
});

test('the commands run in the repo root whatever folder the runner is started from', () => {
  withRows([{ id: 'C1', command: 'pwd', expected: 'claims-run-test-' }], (r) => {
    const p = spawnSync(process.execPath, [path.join(r.root, 'scripts', 'claims-run.ts'), '--offline'], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(p.status, 0, (p.stdout ?? '') + (p.stderr ?? ''));
  });
});

// ---------- pending rows ----------

test('a pending row prints PENDING <id> AIR-<nnn>, is not run, and the last line counts it', () => {
  withRows([
    { id: 'C1', command: 'echo yes', expected: 'yes' },
    { id: 'C6', command: 'pending: AIR-228 echo ran > ran.txt', expected: 'x' },
  ], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
    assert.ok(res.lines.includes('PENDING C6 AIR-228'), dump(res));
    assert.ok(!fs.existsSync(path.join(r.root, 'ran.txt')), 'the pending command was run');
    assert.equal(res.last, 'CLAIMS OFFLINE OK 1 rows (1 pending)');
  });
});

test('only pending rows give 0 rows and the pending count, every pending row is counted', () => {
  withRows([
    { id: 'C1', command: 'pending: AIR-030 echo a', expected: '' },
    { id: 'C2', command: 'pending: AIR-222 echo b', expected: '' },
  ], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
    assert.equal(res.last, 'CLAIMS OFFLINE OK 0 rows (2 pending)');
    assert.ok(res.lines.includes('PENDING C1 AIR-030') && res.lines.includes('PENDING C2 AIR-222'));
  });
});

test('a pending: marker without a ticket id is a FAIL and the command is not run', () => {
  withRows([{ id: 'C1', command: 'pending: echo ran > ran.txt', expected: 'x' }], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 1, dump(res));
    assert.match(res.lines.find((l) => l.startsWith('FAIL C1: ')) ?? '', /pending/);
    assert.ok(!fs.existsSync(path.join(r.root, 'ran.txt')));
  });
});

// ---------- Needs: none, network, keys, and the modes ----------

test('an empty table gives CLAIMS OFFLINE OK 0 rows and exit 0, with a header only or no table at all', () => {
  withRows([], (r) => {
    const res = run(r, ['--offline']);
    assert.equal(res.code, 0, dump(res));
    assert.equal(res.last, 'CLAIMS OFFLINE OK 0 rows');
  });
  withRepo('# Claims\n\nNo table here.\n', {}, (r) => {
    const res = run(r, ['--network']);
    assert.equal(res.code, 0, dump(res));
    assert.equal(res.last, 'CLAIMS NETWORK OK 0 rows');
  });
});

test('a keys row is listed and never run, in both modes', () => {
  withRows([{ id: 'C9', command: 'echo ran > ran.txt; echo k', expected: 'k', needs: 'keys' }], (r) => {
    for (const mode of ['--offline', '--network']) {
      const res = run(r, [mode]);
      assert.equal(res.code, 0, dump(res));
      assert.ok(res.lines.includes('SKIP C9 needs keys'), dump(res));
      assert.ok(!fs.existsSync(path.join(r.root, 'ran.txt')));
      assert.match(res.last, /^CLAIMS (OFFLINE|NETWORK) OK 0 rows$/);
    }
  });
});

test('--offline runs the rows that need no network and leaves the network rows alone, --network the reverse', () => {
  const rows: Row[] = [
    { id: 'C1', command: 'echo one', expected: 'one' },
    { id: 'C2', command: 'echo two', expected: 'two', needs: 'network' },
    { id: 'C3', command: 'echo three', expected: 'three', needs: 'rust,lean' },
  ];
  withRows(rows, (r) => {
    const off = run(r, ['--offline']);
    assert.equal(off.code, 0, dump(off));
    assert.deepEqual(off.lines.filter((l) => l.startsWith('PASS ')).map((l) => l.split(' ')[1]), ['C1', 'C3']);
    assert.equal(off.last, 'CLAIMS OFFLINE OK 2 rows');
    const net = run(r, ['--network']);
    assert.equal(net.code, 0, dump(net));
    assert.deepEqual(net.lines.filter((l) => l.startsWith('PASS ')).map((l) => l.split(' ')[1]), ['C2']);
    assert.equal(net.last, 'CLAIMS NETWORK OK 1 rows');
  });
});

test('--offline does not look for tools: a row that names a tool the machine lacks runs and passes on its own output', () => {
  withRows([{ id: 'C1', command: 'echo ok', expected: 'ok', needs: 'kani' }], (r) => {
    const res = run(r, ['--offline'], { ...process.env, PATH: path.dirname(process.execPath) + ':/usr/bin:/bin' });
    assert.equal(res.code, 0, dump(res));
    assert.ok(has(res, /^PASS C1 /));
  });
});

test('a pending row shows only in the mode that selects it, a pending keys row shows in both', () => {
  withRows([
    { id: 'C1', command: 'pending: AIR-246 echo a', expected: '' },
    { id: 'C2', command: 'pending: AIR-228 echo b', expected: '', needs: 'network' },
    { id: 'C3', command: 'pending: AIR-255 echo c', expected: '', needs: 'keys' },
  ], (r) => {
    const off = run(r, ['--offline']);
    assert.deepEqual(off.lines.filter((l) => l.startsWith('PENDING ')), ['PENDING C1 AIR-246', 'PENDING C3 AIR-255']);
    assert.equal(off.last, 'CLAIMS OFFLINE OK 0 rows (2 pending)');
    const net = run(r, ['--network']);
    assert.deepEqual(net.lines.filter((l) => l.startsWith('PENDING ')), ['PENDING C2 AIR-228', 'PENDING C3 AIR-255']);
    assert.equal(net.last, 'CLAIMS NETWORK OK 0 rows (2 pending)');
  });
});

test('no flag means --offline', () => {
  withRows([{ id: 'C1', command: 'echo one', expected: 'one' }, { id: 'C2', command: 'echo two', expected: 'two', needs: 'network' }], (r) => {
    const res = run(r, []);
    assert.equal(res.code, 0, dump(res));
    assert.equal(res.last, 'CLAIMS OFFLINE OK 1 rows');
  });
});

// ---------- inputs and usage ----------

test('a missing docs/CLAIMS.md exits 2 with an INPUT MISSING line', () => {
  withRows([], (r) => {
    fs.rmSync(path.join(r.root, 'docs', 'CLAIMS.md'));
    const res = run(r, ['--offline']);
    assert.equal(res.code, 2, dump(res));
    assert.ok(res.lines.some((l) => /^INPUT MISSING .*CLAIMS\.md$/.test(l)), dump(res));
  });
});

test('a folder that is not a git work tree exits 2', () => {
  withRows([{ id: 'C1', command: 'echo a', expected: 'a' }], (r) => {
    fs.rmSync(path.join(r.root, '.git'), { recursive: true, force: true });
    // an enclosing repo would hide the problem, so run in a folder whose parents have no .git: the temp folder itself
    const res = run(r, ['--offline'], { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(r.root) });
    assert.equal(res.code, 2, dump(res));
    assert.ok(res.lines.some((l) => l.startsWith('INPUT MISSING ')), dump(res));
  });
});

test('usage errors exit 2: an unknown flag, --offline with --network, --offline with --tier, a bad tier name', () => {
  withRows([{ id: 'C1', command: 'echo a', expected: 'a' }], (r) => {
    for (const args of [['--bogus'], ['--offline', '--network'], ['--offline', '--tier', 'node'], ['--tier', 'gold'], ['--tier'], ['--network', '--tier']]) {
      const res = run(r, args);
      assert.equal(res.code, 2, args.join(' ') + '\n' + dump(res));
      assert.ok(!has(res, /^PASS /), 'a usage error must not run rows: ' + args.join(' '));
    }
    assert.match(run(r, ['--tier']).err, /--tier needs a value/);
    assert.match(run(r, ['--tier', 'gold']).err, /unknown tier gold/);
    assert.match(run(r, ['--offline', '--network']).err, /exclude each other/);
  });
});

// ---------- the wrapper ----------

function runWrapper(r: Repo, args: string[], env: NodeJS.ProcessEnv): Result {
  return split(spawnSync('/bin/bash', [path.join(r.root, 'scripts', 'claims-run.sh'), ...args], { cwd: r.root, encoding: 'utf8', env }));
}

function binDir(links: Record<string, string>, scripts: Record<string, string> = {}): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-run-bin-'));
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(d, name));
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(d, name), body, { mode: 0o755 });
  return d;
}

function realGit(): string {
  return (spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout ?? '').trim();
}

test('the wrapper runs the runner with its arguments and returns its exit code', () => {
  withRows([{ id: 'C1', command: 'echo one', expected: 'one' }, { id: 'C2', command: 'echo two', expected: 'nope', needs: 'network' }], (r) => {
    const bin = binDir({ node: process.execPath, git: realGit() });
    try {
      const env = { PATH: bin + ':/usr/bin:/bin' };
      const off = runWrapper(r, ['--offline'], env);
      assert.equal(off.code, 0, dump(off));
      assert.equal(off.last, 'CLAIMS OFFLINE OK 1 rows');
      const net = runWrapper(r, ['--network'], env);
      assert.equal(net.code, 1, dump(net));
      assert.equal(net.last, 'CLAIMS NETWORK FAIL 1 failed');
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

test('the wrapper says so and exits 2 when node is not on the PATH', () => {
  withRows([], (r) => {
    const bin = binDir({ git: realGit() });
    try {
      const res = runWrapper(r, ['--offline'], { PATH: bin + ':/usr/bin:/bin' });
      assert.equal(res.code, 2, dump(res));
      assert.match(res.err, /node/);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

test('the wrapper runs a node of 22.18, 23.6 or 24 and refuses older ones, with a message that names the versions', () => {
  withRows([], (r) => {
    for (const [version, accepted] of [['v24.0.0', true], ['v23.6.0', true], ['v23.5.9', false], ['v22.18.0', true], ['v22.17.9', false], ['v22.0.0', false], ['v20.19.0', false], ['garbage', false]] as [string, boolean][]) {
      const bin = binDir({ git: realGit() }, { node: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo ' + version + '; else echo "stub node $*"; fi\n' });
      try {
        const res = runWrapper(r, ['--offline'], { PATH: bin + ':/usr/bin:/bin' });
        if (accepted) {
          assert.equal(res.code, 0, version + '\n' + dump(res));
          assert.match(res.lines[0] ?? '', /^stub node .*claims-run\.ts --offline$/, version);
        } else {
          assert.equal(res.code, 2, version + '\n' + dump(res));
          assert.match(res.err, /Node 24.*Node 22\.18/, version);
          assert.ok(!/integer expression/.test(res.err), 'a version that does not parse must not leak a test error: ' + res.err);
          assert.equal(res.lines.length, 0, 'the runner must not start on ' + version);
        }
      } finally {
        fs.rmSync(bin, { recursive: true, force: true });
      }
    }
  });
});

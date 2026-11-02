// AIR-241: plumbing-doc.sh --check fails on a table with a changed row and on a row whose test name is absent from its file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'plumbing-doc.sh');
const HOME_FILE = 'scripts/plumbing-doc.sh';

function setup(tsRows: string): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'air241-'));
  const index = join(dir, 'index.sh');
  writeFileSync(index, `#!/usr/bin/env bash\necho 'alpha | usage: scripts/plumbing-doc.sh | ${HOME_FILE}'\necho 'PLUMBING INDEX OK (1 rows)'\n`);
  chmodSync(index, 0o755);
  const rows = join(dir, 'rows.txt');
  writeFileSync(rows, tsRows);
  const doc = join(dir, 'PLUMBING.md');
  writeFileSync(doc, '# Plumbing\n\nhand written\n');
  return { dir, env: { PATH: process.env['PATH'] ?? '', PLUMBING_DOC: doc, PLUMBING_TS_ROWS: rows, PLUMBING_INDEX: index } };
}
const run = (env: Record<string, string>, ...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8', cwd: ROOT });

test('writes the table, then --check passes; a changed row or a stale table fails', () => {
  const { dir, env } = setup(`beta | plumbing-doc.sh | ${HOME_FILE}\n`);
  try {
    assert.equal(run(env, '--check').status, 1, 'no table yet');
    assert.equal(run(env).status, 0);
    const doc = env['PLUMBING_DOC'] as string;
    const text = readFileSync(doc, 'utf8');
    assert.match(text, /hand written/);
    assert.match(text, /^\| Class \| Test \| File \|$/m);
    assert.match(text, /^\| --- \| --- \| --- \|$/m);
    assert.equal(run(env, '--check').status, 0);
    writeFileSync(doc, text.replace('| beta |', '| gamma |'));
    const stale = run(env, '--check');
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /PLUMBING DOC STALE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a row whose test name does not occur in its file fails', () => {
  const { dir, env } = setup(`beta | no_such_test_name_anywhere | ${HOME_FILE}\n`);
  try {
    const r = run(env);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /test name not in scripts\/plumbing-doc\.sh: no_such_test_name_anywhere/);
    assert.equal(run(env, '--check').status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// AIR-228: the replay path has no clock, locale, path or network in it, the shim stops every outbound connection, and the check script
// fails when the manifest is missing or a recording changed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { renderBlock } from '../src/report/render.ts';
import { fixtureRuns, resultsOf } from './helpers/runs.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SHIM = join(ROOT, 'scripts', 'no-network.cjs');
const HELPER = join(HERE, 'helpers', 'render-cli.ts');

function render(variant: string, env: Record<string, string>): string {
  const r = spawnSync(process.execPath, ['--import', 'tsx', HELPER, variant], { env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('a block with the clock in it differs between time zones, the real renderBlock does not and ignores the locale', () => {
  const auckland = { TZ: 'Pacific/Auckland', LC_ALL: 'de_DE.UTF-8' };
  const vancouver = { TZ: 'America/Vancouver', LC_ALL: 'C' };
  assert.notEqual(render('bad', auckland), render('bad', vancouver));
  const a = render('real', auckland);
  assert.equal(a, render('real', vancouver));
  assert.equal(a, renderBlock(resultsOf(fixtureRuns())));
});

test('the block holds no absolute path, ISO date or 13-digit epoch', () => {
  const block = renderBlock(resultsOf(fixtureRuns()));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /\/Users\/|\/home\/|\/private\//);
  assert.doesNotMatch(block, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(block, /\b\d{13}\b/);
  assert.ok(!block.includes('\r'));
});

function node(code: string, extra: string[] = []): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['-e', code, ...extra], {
    env: { PATH: process.env['PATH'] ?? '', NODE_OPTIONS: `--require ${SHIM}` },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('no-network.cjs stops fetch to a loopback server, http.get and net.connect, and leaves child process pipes alone', async () => {
  const server = createServer((_q, s) => s.end('hi'));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  try {
    const f = node(`fetch('http://127.0.0.1:${port}/').then(() => process.exit(0), (e) => { console.error(String(e.cause ? e.cause.message : e.message)); process.exit(1) })`);
    assert.equal(f.status, 1);
    assert.match(f.out, /network blocked/);
    const h = node(`require('node:http').get('http://127.0.0.1:${port}/', () => process.exit(0)).on('error', (e) => { console.error(e.message); process.exit(1) })`);
    assert.equal(h.status, 1);
    assert.match(h.out, /network blocked/);
    const n = node(`try { require('node:net').connect(${port}, '127.0.0.1').on('error', (e) => { console.error(e.message); process.exit(1) }) } catch (e) { console.error(e.message); process.exit(1) }`);
    assert.equal(n.status, 1);
    assert.match(n.out, /network blocked/);
  } finally {
    server.close();
  }
  const c = node(`const r = require('node:child_process').spawnSync('echo', ['piped'], { encoding: 'utf8' }); process.stdout.write(r.stdout)`);
  assert.equal(c.status, 0);
  assert.equal(c.out.trim(), 'piped');
});

test('bench-replay-check.sh loads the shim by absolute path and fails with FAIL manifest when the manifest is missing or a recording changed', () => {
  const script = join(ROOT, 'scripts', 'bench-replay-check.sh');
  assert.ok(readFileSync(script, 'utf8').includes('$PWD/scripts/no-network.cjs'));
  const dir = mkdtempSync(join(tmpdir(), 'air228-'));
  try {
    const rec = join(dir, 'rec');
    mkdirSync(rec);
    writeFileSync(join(rec, 'a.json'), '{}\n');
    const run = (): { status: number | null; out: string } => {
      const r = spawnSync('bash', [script], { env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', BENCH_RECORDED: rec }, encoding: 'utf8' });
      return { status: r.status, out: r.stdout + r.stderr };
    };
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.out, /FAIL manifest/);
    const sum = spawnSync('sha256sum', ['a.json'], { cwd: rec, encoding: 'utf8' });
    writeFileSync(join(rec, 'MANIFEST.sha256'), sum.stdout);
    writeFileSync(join(rec, 'a.json'), '{"x":1}\n');
    const changed = run();
    assert.equal(changed.status, 1);
    assert.match(changed.out, /FAIL manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

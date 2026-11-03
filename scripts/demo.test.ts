// AIR-246: the two network shims, the demo arguments, and the loud failure for a missing recording. No network beyond loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from './demo.ts';

const ROOT = join(import.meta.dirname, '..');
const run = (shim: string, code: string) => spawnSync(process.execPath, ['-r', join(ROOT, 'scripts', shim), '-e', code], { encoding: 'utf8', timeout: 20_000 });

const BLOCKED = (url: string) => `fetch(${JSON.stringify(url)}).then(() => process.exit(1), (e) => { console.log(String(e.cause ? e.cause.message : e.message)); process.exit(0) })`;
const LOOPBACK = (host: string) =>
  `const s = require('http').createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', () => fetch('http://${host}:' + s.address().port).then((r) => r.text()).then((t) => { console.log(t); process.exit(0) }, (e) => { console.log('ERR ' + String(e.cause ? e.cause.message : e.message)); process.exit(1) }))`;

test('no-network-demo.cjs lets loopback and localhost through and blocks example.com over http and https', () => {
  assert.equal(run('no-network-demo.cjs', LOOPBACK('127.0.0.1')).stdout.trim(), 'ok');
  assert.equal(run('no-network-demo.cjs', LOOPBACK('localhost')).stdout.trim(), 'ok');
  for (const url of ['http://example.com/', 'https://example.com/']) {
    const r = run('no-network-demo.cjs', BLOCKED(url));
    assert.equal(r.status, 0, url);
    assert.match(r.stdout, /network blocked: example\.com/);
  }
});

test('no-network.cjs blocks every outbound connection, loopback included, and still lets a process listen', () => {
  const r = run('no-network.cjs', LOOPBACK('127.0.0.1'));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ERR network blocked/);
  assert.match(run('no-network.cjs', BLOCKED('https://example.com/')).stdout, /network blocked/);
});

test('parseArgs reads the flags and refuses the rest', () => {
  const a = parseArgs(['--no-open', '--exit-when-ready', '--golden', 'g', '--chain', 'c', '--console-port', '4300', '--runtime-port', '8800']);
  assert.ok(a !== null);
  assert.deepEqual([a.open, a.exitWhenReady, a.consolePort, a.runtimePort], [false, true, 4300, 8800]);
  assert.ok(a.golden.endsWith('/g') && a.chain.endsWith('/c'));
  const d = parseArgs([]);
  assert.deepEqual([d?.open, d?.consolePort, d?.runtimePort], [true, 4173, 8787]);
  for (const bad of [['--wat'], ['--golden'], ['--console-port', 'x'], ['--console-port', '123456']]) assert.equal(parseArgs(bad), null, JSON.stringify(bad));
});

test('pnpm demo with an empty golden directory exits 1 and prints the MISSING line, starting nothing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'demo-miss-'));
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'demo.ts'), '--no-open', '--exit-when-ready', '--golden', empty, '--console-port', '4398', '--runtime-port', '8898'], { encoding: 'utf8', timeout: 60_000, cwd: ROOT });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), `MISSING ${join(empty, 'u01.json')}`);
});

test('pnpm demo exits 1 at once and names the flag when its console port is already taken', async () => {
  const { createServer } = await import('node:net');
  const holder = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => holder.once('listening', r));
  const port = (holder.address() as { port: number }).port;
  try {
    const r = await new Promise<{ status: number | null; stdout: string }>((resolveRun) => {
      let out = '';
      import('node:child_process').then(({ spawn }) => {
        const p = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'demo.ts'), '--no-open', '--exit-when-ready', '--console-port', String(port), '--runtime-port', '8897'], { cwd: ROOT });
        p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        p.on('exit', (status) => resolveRun({ status, stdout: out }));
      });
    });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.trim(), `port ${String(port)} is already in use: stop what holds it or pass --console-port <free port>`);
  } finally {
    holder.close();
  }
});

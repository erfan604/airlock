// AIR-319: the npm package airlock-near-mcp. Source-level tests of --check, --help, --print-config, the settings and the refusals, then a test of
// the bundle itself: build it, run `node dist/cli.js --check` from a folder outside the repo, and check the size and that no key is in it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveConfig } from '../src/args.ts';
import { run } from '../src/run.ts';

const pkg = fileURLToPath(new URL('../', import.meta.url));

async function call(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, env, (l) => out.push(l), (l) => err.push(l));
  return { code, out, err };
}

test('--check runs the five Try-page cases through the real verdict and ends with AIRLOCK MCP OK', async () => {
  const r = await call(['--check']);
  assert.equal(r.code, 0);
  assert.match(r.out[0] ?? '', /^verdict\.wasm \d+ bytes sha256 [0-9a-f]{64}$/);
  const cases = r.out.slice(1, -1);
  assert.deepEqual(
    cases.map((l) => l.replace(/\s+/g, ' ')),
    [
      'ok doctored escalate:UntrustedAmount',
      'ok lookalike escalate:OutsideTask',
      'ok newpayee escalate:OutsideTask',
      'ok otherbooked escalate:OutsideTask',
      'ok honest allow',
    ],
  );
  assert.equal(r.out.at(-1), 'AIRLOCK MCP OK');
});

test('--help documents every setting, the environment names and testnet only', async () => {
  const r = await call(['--help']);
  assert.equal(r.code, 0);
  const text = r.out.join('\n');
  for (const name of ['--policy', '--agent', '--agent-key-file', '--task-key-file', '--print-config', '--check', 'AIRLOCK_MCP_CONFIG', 'AIRLOCK_POLICY', 'AIRLOCK_AGENT_KEY_FILE', 'testnet']) {
    assert.ok(text.includes(name), name);
  }
});

test('--print-config claude prints a mcpServers entry that starts the package through npx', async () => {
  const r = await call(['--print-config', 'claude'], { AIRLOCK_MCP_CONFIG: '/home/u/.airlock/mcp.json' });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out.join('\n')) as { mcpServers: { airlock: { command: string; args: string[]; env: Record<string, string> } } };
  assert.equal(j.mcpServers.airlock.command, 'npx');
  assert.deepEqual(j.mcpServers.airlock.args, ['-y', 'airlock-near-mcp']);
  assert.deepEqual(j.mcpServers.airlock.env, { AIRLOCK_MCP_CONFIG: '/home/u/.airlock/mcp.json' });
  const c = await call(['--print-config', 'claude-code'], { AIRLOCK_MCP_CONFIG: '/home/u/.airlock/mcp.json' });
  assert.equal(c.out[0], 'claude mcp add airlock --env AIRLOCK_MCP_CONFIG=/home/u/.airlock/mcp.json -- npx -y airlock-near-mcp');
});

test('a key on the command line is refused, and so is an unknown option', async () => {
  const k = await call(['--agent-key-file', 'ed25519:3tRm9vVvQ1xJ']);
  assert.equal(k.code, 2);
  assert.match(k.err[0] ?? '', /never a key/);
  assert.equal((await call(['--task-key-file', 'a'.repeat(64)])).code, 2);
  assert.equal((await call(['--mainnet'])).code, 2);
});

test('settings from the environment build a testnet config; a mainnet account is refused; missing settings are named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airlock-319-'));
  try {
    const env = {
      AIRLOCK_POLICY: 'p.testnet',
      AIRLOCK_AGENT: 'agent.o.testnet',
      AIRLOCK_OWNER: 'o.testnet',
      AIRLOCK_AGENT_KEY_FILE: join(dir, 'agent.json'),
      AIRLOCK_TASK_KEY_FILE: join(dir, 'task'),
      AIRLOCK_REQUEST: 'Pay Acme.',
      AIRLOCK_BOUND: 'Acme=3,Other=1.5',
    };
    const cfg = resolveConfig(parseArgs([]), env);
    assert.equal(cfg.network, 'testnet');
    assert.equal(cfg.contract_id, 'p.testnet');
    assert.deepEqual(cfg.bounds, [{ payee: 'Acme', max_total: '3' }, { payee: 'Other', max_total: '1.5' }]);
    assert.throws(() => resolveConfig(parseArgs([]), { ...env, AIRLOCK_POLICY: 'p.near' }), /testnet only/);
    assert.throws(() => resolveConfig(parseArgs([]), { AIRLOCK_POLICY: 'p.testnet' }), /missing --agent, --owner, --agent-key-file, --request, --bound/);
    assert.throws(() => resolveConfig(parseArgs([]), {}, () => false), /no config at/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the bundle runs --check from outside the repo, is under 5 MB, has no install script and holds no key', () => {
  const b = spawnSync(process.execPath, ['build.mjs'], { cwd: pkg, encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  const bundle = join(pkg, 'dist', 'cli.js');
  assert.ok(statSync(bundle).size < 5 * 1024 * 1024);
  const outside = mkdtempSync(join(tmpdir(), 'airlock-319-run-'));
  try {
    const r = spawnSync(process.execPath, [bundle, '--check'], { cwd: outside, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: outside } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trimEnd().split('\n').at(-1), 'AIRLOCK MCP OK');
    writeFileSync(join(outside, 'x'), '');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  const text = readFileSync(bundle, 'utf8');
  assert.ok(!/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/.test(text), 'a key shape is in the bundle');
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { scripts: Record<string, string>; dependencies?: unknown };
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts[hook], undefined, hook);
  assert.equal(manifest.dependencies, undefined);
});

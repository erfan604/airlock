// AIR-319: proves the package from a packed tarball. `npm pack` makes airlock-near-mcp-<version>.tgz; in a fresh folder outside the repo (and
// a fresh npm cache) `npx -y <tarball> --check` runs, and `npx -y <tarball>` is started as an MCP client would: an initialize, then tools/list
// over stdio, with a throwaway config and throwaway keys made here (no account, nothing real; the RPC is a loopback stand-in that answers `status` with a chain_id). Everything it made is deleted.
// Usage: node scripts/prove-tarball.mjs [<base folder, default /private/tmp/claude-501>]
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgDir, '..', '..');
const base = process.argv[2] ?? '/private/tmp/claude-501';
mkdirSync(base, { recursive: true });
const work = mkdtempSync(join(base, 'airlock-319-'));
const say = (l) => console.log(l);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = BigInt(`0x${buf.toString('hex')}`);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}

let failed = false;
try {
  const packDir = join(work, 'pack');
  const runDir = join(work, 'run');
  const cache = join(work, 'npm-cache');
  mkdirSync(packDir);
  mkdirSync(runDir);
  const env = { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };

  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  say(`package ${manifest.name} ${manifest.version}`);
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: pkgDir, encoding: 'utf8', env });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr.slice(-300)}`);
  const info = JSON.parse(packed.stdout)[0];
  say(`tarball ${info.filename} ${String(info.size)} bytes unpacked ${String(info.unpackedSize)} bytes`);
  say('files:');
  for (const f of info.files) say(`  ${f.path} ${String(f.size)}`);
  const tgz = join(packDir, info.filename);
  if (info.size >= 5 * 1024 * 1024) throw new Error('tarball is 5 MB or more');
  if (info.files.some((f) => /(^|\/)(\.env|.*\.pem|.*\.key|.*credentials.*)$/i.test(f.path))) throw new Error('a secret-shaped file is in the tarball');
  if (resolveInside(tgz, repoRoot)) throw new Error('tarball is inside the repo');
  say(`tarball sha256 ${createHash('sha256').update(readFileSync(tgz)).digest('hex')}`);
  copyFileSync(tgz, join(runDir, info.filename));
  const spec = `./${info.filename}`;

  // 1. --check from the tarball, in a folder outside the repo
  say('');
  say(`$ npx -y ./${info.filename} --check   (fresh folder and npm cache outside the repo)`);
  const chk = spawnSync('npx', ['-y', spec, '--check'], { cwd: runDir, encoding: 'utf8', env });
  process.stdout.write(chk.stdout);
  if (chk.status !== 0 || chk.stdout.trimEnd().split('\n').at(-1) !== 'AIRLOCK MCP OK') {
    failed = true;
    say(`FAILED --check exit ${String(chk.status)} ${chk.stderr.slice(-300)}`);
  }

  // 2. the stdio handshake, with a throwaway config and throwaway keys
  say('');
  const kp = generateKeyPairSync('ed25519');
  const seed = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const agent = 'agent.throwaway.testnet';
  writeFileSync(join(runDir, 'agent.json'), JSON.stringify({ account_id: agent, public_key: `ed25519:${base58(pub)}`, private_key: `ed25519:${base58(Buffer.concat([seed, pub]))}` }), { mode: 0o600 });
  writeFileSync(join(runDir, 'task-key'), `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  // AIR-322: the server asks the RPC for its chain_id at start; a loopback stand-in answers testnet (then mainnet, which must be refused)
  let chainId = 'testnet';
  const stub = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'airlock', result: { chain_id: chainId } }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const rpcUrl = `http://127.0.0.1:${String(stub.address().port)}`;
  writeFileSync(
    join(runDir, 'mcp.json'),
    JSON.stringify({
      network: 'testnet',
      rpc: [rpcUrl],
      owner_id: 'throwaway.testnet',
      contract_id: 'throwaway-policy.testnet',
      agent_id: agent,
      agent_credentials: 'agent.json',
      task_key_file: 'task-key',
      request: 'Pay Acme.',
      bounds: [{ payee: 'Acme', max_total: '1' }],
    }),
    { mode: 0o600 },
  );
  say(`$ npx -y ./${info.filename}   (stdio, AIRLOCK_MCP_CONFIG with a throwaway config; send initialize, then tools/list)`);
  const child = spawn('npx', ['-y', spec], { cwd: runDir, env: { ...env, AIRLOCK_MCP_CONFIG: join(runDir, 'mcp.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === '') continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    }
  });
  const rpc = (id, method, params) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer to ${method}: ${stderr.slice(-300)}`)), 60_000);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prove-tarball', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await rpc(2, 'tools/list', {});
    const names = tools.result.tools.map((t) => t.name);
    const expected = ['owner_request', 'read_email', 'fetch_page', 'read_file', 'book_list', 'pay'];
    say(`initialize: server ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`);
    say(`tools/list: ${names.join(', ')}`);
    if (JSON.stringify([...names].sort()) !== JSON.stringify([...expected].sort())) throw new Error('unexpected tool list');
    say(`stderr: ${stderr.trim().split('\n').at(-1)}`);
    say('HANDSHAKE OK');
    // M3: a request with string params is answered with -32602, not dropped
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: 'x' })}\n`);
    const bad = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no answer to string params')), 10_000);
      pending.set(3, (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
    if (bad.error?.code !== -32602) throw new Error('string params were not answered with -32602');
    say('PARAMS OK: string params answered with -32602');
  } catch (e) {
    failed = true;
    say(`FAILED handshake: ${e instanceof Error ? e.message : 'unknown'}`);
  } finally {
    child.kill();
  }
  // H1: the same config against an RPC that says mainnet must not start
  chainId = 'mainnet';
  // async: the stand-in RPC lives in this process, so a blocking spawn could not answer it
  const refusal = await new Promise((resolve) => {
    const c = spawn('npx', ['-y', spec], { cwd: runDir, env: { ...env, AIRLOCK_MCP_CONFIG: join(runDir, 'mcp.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => c.kill(), 60_000);
    c.on('close', (status) => {
      clearTimeout(t);
      resolve({ status, stderr: err });
    });
  });
  const line = refusal.stderr.trim().split('\n').at(-1) ?? '';
  say(`mainnet RPC: exit ${String(refusal.status)}, ${line}`);
  if (refusal.status === 0 || !line.includes('testnet only')) {
    failed = true;
    say('FAILED: a mainnet RPC was not refused');
  } else say('MAINNET REFUSED OK');
  stub.close();
} finally {
  rmSync(work, { recursive: true, force: true });
  say(`removed ${work}`);
}
process.exitCode = failed ? 1 : 0;

function resolveInside(file, root) {
  return file.startsWith(`${root}/`);
}

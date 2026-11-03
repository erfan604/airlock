// AIR-246: `pnpm demo`. Starts the replay server and the console and prints `console http://127.0.0.1:4173` then, as the last line, `ready in <n>s`.
//   pnpm demo [--no-open] [--exit-when-ready] [--golden <dir>] [--chain <dir>]
// The demo replays recorded testnet runs (bench/golden/*.json and runtime/recordings/chain/b01-escalate.json) with no keys and no network. The replay
// server runs under scripts/no-network.cjs (it may not open any outbound connection) and the Vite preview under scripts/no-network-demo.cjs
// (loopback only, because its proxy talks to the replay server). A missing recording prints the server's `MISSING <path>` line and exits 1: there is
// never a half started demo.
// TODO(AIR-166 golden): bench/golden/{u01,b01-escalate,b01-approve,tamper}.json and runtime/recordings/chain/b01-escalate.json are written by the live
// golden runs (scripts/golden.ts) and committed with them; until then `pnpm demo` prints MISSING <path> and exits 1. The tests and the e2e run over the
// SYNTHETIC fixtures of runtime/test/fixtures/demo through --golden and --chain. Each child is its own process group and both groups are stopped on exit. No .env file is read and no secret is passed:
// the children get PATH, HOME, COREPACK_HOME and the mode variables only.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const READY_LIMIT_MS = 90_000;
const POLL_MS = 250;

export interface DemoArgs {
  open: boolean;
  exitWhenReady: boolean;
  golden: string;
  chain: string;
  /** the two ports; the defaults are the documented ones, the flags exist for a machine where they are taken */
  consolePort: number;
  runtimePort: number;
}

export function parseArgs(argv: readonly string[]): DemoArgs | null {
  const out: DemoArgs = { open: true, exitWhenReady: false, golden: join(ROOT, 'bench', 'golden'), chain: join(ROOT, 'runtime', 'recordings', 'chain'), consolePort: 4173, runtimePort: 8787 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') out.open = false;
    else if (a === '--exit-when-ready') out.exitWhenReady = true;
    else if ((a === '--golden' || a === '--chain') && argv[i + 1] !== undefined) {
      out[a === '--golden' ? 'golden' : 'chain'] = resolve(argv[++i] as string);
    } else if ((a === '--console-port' || a === '--runtime-port') && /^[0-9]{1,5}$/.test(argv[i + 1] ?? '')) {
      out[a === '--console-port' ? 'consolePort' : 'runtimePort'] = JSON.parse(argv[++i] as string) as number;
    } else return null;
  }
  return out;
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', ...extra };
  for (const key of ['HOME', 'COREPACK_HOME', 'TMPDIR']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

const shim = (name: string): string => `--require ${join(ROOT, 'scripts', name)}`;

function stopGroup(child: ChildProcess | null): void {
  if (child === null || child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

async function ready(consoleUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${consoleUrl}/session`, { signal: AbortSignal.timeout(2000) });
    return res.status === 200 && res.headers.get('x-airlock-mode') === 'replay';
  } catch {
    return false;
  }
}

/** True when something already answers on 127.0.0.1:<port>; the demo says so at once instead of waiting 90 s for a foreign server. */
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolveBusy) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(1000);
    sock.once('connect', () => {
      sock.destroy();
      resolveBusy(true);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolveBusy(false);
    });
    sock.once('error', () => resolveBusy(false));
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    console.log('usage: pnpm demo [--no-open] [--exit-when-ready] [--golden <dir>] [--chain <dir>] [--console-port <n>] [--runtime-port <n>]');
    return 2;
  }
  for (const [flag, port] of [['--console-port', args.consolePort], ['--runtime-port', args.runtimePort]] as const) {
    if (await portBusy(port)) {
      console.log(`port ${String(port)} is already in use: stop what holds it or pass ${flag} <free port>`);
      return 1;
    }
  }
  const started = Date.now();
  const consoleUrl = `http://127.0.0.1:${args.consolePort}`;
  const runtimeOrigin = `http://127.0.0.1:${args.runtimePort}`;
  const children: ChildProcess[] = [];
  let server: ChildProcess | null = null;
  let preview: ChildProcess | null = null;
  const stopAll = (): void => {
    stopGroup(preview);
    stopGroup(server);
  };
  process.on('SIGINT', () => {
    stopAll();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stopAll();
    process.exit(143);
  });

  // 1. the replay server first: a missing recording must stop everything before any build starts
  const serverLines: string[] = [];
  server = spawn(process.execPath, ['--import', 'tsx', 'src/demo/serve.ts', '--golden', args.golden, '--chain', args.chain, '--port', String(args.runtimePort)], {
    cwd: join(ROOT, 'runtime'),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ AIRLOCK_MODE: 'replay', LLM_MODE: 'replay', NODE_OPTIONS: shim('no-network.cjs') }),
  });
  children.push(server);
  const serverExit = new Promise<number>((resolveExit) => server?.once('exit', (code) => resolveExit(code ?? 1)));
  let serverListening: () => void = () => undefined;
  const listening = new Promise<void>((resolveListening) => {
    serverListening = resolveListening;
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        serverLines.push(line);
        if (line.startsWith('replay server ')) serverListening();
      }
    });
  }
  const first = await Promise.race([listening.then(() => 'up' as const), serverExit.then((code) => code)]);
  if (first !== 'up') {
    const missing = serverLines.filter((l) => l.startsWith('MISSING '));
    for (const line of missing.length > 0 ? missing : serverLines) console.log(line);
    return 1;
  }

  // 2. the console build, when there is none
  if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) {
    const built = spawnSync('pnpm', ['-C', join(ROOT, 'web'), 'build'], {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: childEnv({ VITE_CONTRACT_ID: 'policy.test.near', VITE_AGENT_ACCOUNT_ID: 'agent.test.near', VITE_RUNTIME_ORIGIN: runtimeOrigin }),
    });
    if (built.status !== 0) {
      console.log('console build failed');
      stopAll();
      return 1;
    }
  }

  // 3. the console, under the loopback shim
  preview = spawn(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(args.consolePort), '--strictPort'], {
    cwd: join(ROOT, 'web'),
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: childEnv({ AIRLOCK_MODE: 'replay', LLM_MODE: 'replay', VITE_RUNTIME_ORIGIN: runtimeOrigin, VITE_CONTRACT_ID: 'policy.test.near', VITE_AGENT_ACCOUNT_ID: 'agent.test.near', NODE_OPTIONS: shim('no-network-demo.cjs') }),
  });
  children.push(preview);
  const previewErr: string[] = [];
  preview.stderr?.on('data', (chunk: Buffer) => previewErr.push(chunk.toString('utf8')));
  let previewDied = false;
  preview.once('exit', () => {
    previewDied = true;
  });

  // 4. ready: the session route through the proxy answers 200 in replay mode
  for (;;) {
    if (await ready(consoleUrl)) break;
    if (previewDied) {
      console.log(previewErr.join('').trim().split('\n').slice(-3).join('\n'));
      stopAll();
      return 1;
    }
    if (Date.now() - started > READY_LIMIT_MS) {
      console.log('NOT READY after 90s');
      stopAll();
      return 1;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.log(`console ${consoleUrl}`);
  console.log(`ready in ${Math.max(0, Math.floor((Date.now() - started) / 1000))}s`);
  if (args.exitWhenReady) {
    stopAll();
    await new Promise((r) => setTimeout(r, 300));
    return 0;
  }
  if (args.open) spawn('open', [consoleUrl], { stdio: 'ignore', detached: true }).unref();
  await serverExit;
  stopAll();
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.log(`demo failed: ${e instanceof Error ? e.message : 'unexpected error'}`);
      process.exit(1);
    },
  );
}

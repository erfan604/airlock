// AIR-166: the single command that says whether the world is ready for a golden run.
//   pnpm tsx scripts/preflight.ts [--record-mpc]
// Prints `PASS|FAIL|WARN <name> <detail>` per line and exits 1 on any FAIL. Read-only: no key is read for signing, nothing is sent.
// Env: AGENT_CREDENTIALS_PATH (the agent key check), BASE_SEPOLIA_RPC (tried first when set).
import { fileURLToPath } from 'node:url';
import { formatLine, liveWorld, preflightOk, recordMpc, runPreflight } from './lib/world.ts';
import type { WorldIo } from './lib/world.ts';
import { liveIo } from './lib/preflight.ts';
import type { PreflightIo } from './lib/preflight.ts';
import { flakeLine, describeFailure } from './lib/flake.ts';

export async function main(argv: readonly string[], pf: PreflightIo, w: WorldIo, root: string, out: (l: string) => void = (l) => console.log(l), today = new Date().toISOString().slice(0, 10)): Promise<number> {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--record-mpc')) {
    out('usage: preflight.ts [--record-mpc]');
    return 2;
  }
  try {
    if (argv[0] === '--record-mpc') {
      const next = await recordMpc(w, root, today);
      out(`RECORDED mpc ${next.contract} version ${next.version} code_hash ${next.code_hash} on ${next.recorded}`);
      return 0;
    }
    const lines = await runPreflight(pf, w);
    for (const l of lines) out(formatLine(l));
    return preflightOk(lines) ? 0 : 1;
  } catch (e) {
    out(flakeLine(describeFailure(e)));
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  main(process.argv.slice(2), liveIo(), liveWorld(), root).then((code) => {
    process.exitCode = code;
  });
}

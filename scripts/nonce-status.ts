// AIR-166: the contract's nonce for the EVM path against the chain's pending count of the derived address. Prints the owner's `set_nonce`
// command when they differ, with the AIR-104 warning. It never sends anything. Exit 0 in sync, 1 on a difference or a failed read.
import { fileURLToPath } from 'node:url';
import { liveIo } from './lib/preflight.ts';
import type { PreflightIo } from './lib/preflight.ts';
import { liveWorld, nonceStatus } from './lib/world.ts';
import type { WorldIo } from './lib/world.ts';
import { describeFailure, flakeLine } from './lib/flake.ts';

export async function main(pf: PreflightIo, w: WorldIo, out: (l: string) => void = (l) => console.log(l)): Promise<number> {
  try {
    const lines = await nonceStatus(pf, w);
    for (const l of lines) out(l);
    return lines.some((l) => l.startsWith('OWNER COMMAND')) ? 1 : 0;
  } catch (e) {
    out(flakeLine(describeFailure(e)));
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(liveIo(), liveWorld()).then((code) => {
    process.exitCode = code;
  });
}

// AIR-319: `airlock-near-mcp --check`. It loads the verdict WebAssembly and runs the five cases of the console's Try page through it, the same
// stand-in agent and the same columns (web/src/try/model.ts), and prints one line per case. No key, no network, no account. A case whose
// verdict is not the one its preset lists makes the check fail.
import { createHash } from 'node:crypto';
import { WORLD, columnsOf, defaultKnobs, standIn } from '../../../web/src/try/model.ts';
import { instantiateVerdict, tagOf } from '../../../web/src/try/verdictWasm.ts';
import { verdictWasmBytes } from './wasm.ts';

export async function runCheck(write: (line: string) => void): Promise<boolean> {
  const bytes = verdictWasmBytes();
  write(`verdict.wasm ${String(bytes.length)} bytes sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
  const verdict = await instantiateVerdict(bytes);
  let ok = true;
  for (const preset of WORLD.presets) {
    const found = standIn(preset.email, WORLD);
    if (found.kind !== 'proposal') {
      write(`FAIL ${preset.id}: the stand-in agent found nothing to pay`);
      ok = false;
      continue;
    }
    const tag = tagOf(verdict.decide(columnsOf(found.proposal, defaultKnobs(WORLD), WORLD)));
    const match = tag === preset.expect.default;
    if (!match) ok = false;
    write(`${match ? 'ok' : 'FAIL'} ${preset.id.padEnd(12)} ${tag}${match ? '' : ` (expected ${preset.expect.default})`}`);
  }
  if (WORLD.presets.length !== 5) {
    write(`FAIL expected 5 cases, found ${String(WORLD.presets.length)}`);
    ok = false;
  }
  if (ok) write('AIRLOCK MCP OK');
  return ok;
}

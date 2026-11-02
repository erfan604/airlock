// AIR-102: sign an OwnerTask with the owner's task key and print the arguments submit_batch takes.
//   pnpm tsx scripts/sign-task.ts [--file <path>]   reads the task JSON from the file or stdin, prints one line
//                                                    {"task": <the input>, "task_sig": "<base64>"}
//   pnpm tsx scripts/sign-task.ts --selftest        rebuilds the owner_task vector of fixtures/verdict-vectors.json, signs it with
//                                                    the vector's seed and prints `signature matches owner_task vector` if equal
// The message is the borsh bytes of the task (ownerTaskBorsh, runtime/src/dsl/task.ts), Ed25519 with no prefix. The seed is read only
// from ~/.airlock-task-key by scripts/task-key.mjs and never printed. `signTask` is exported for scripts/mpc-smoke.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnerTask, ownerTaskBorsh, taskHash } from '../runtime/src/dsl/task.ts';
// @ts-expect-error task-key.mjs is plain JavaScript without declarations
import { loadSeedHex, signMessage } from './task-key.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface SignedTask {
  task: OwnerTask;
  task_sig: string;
}

/** Ed25519 over the borsh bytes of the task: `task_sig` is the base64 a `Base64VecU8` takes. */
export function signTask(task: OwnerTask, seedHex: string): SignedTask {
  const bytes = ownerTaskBorsh(task);
  const sig: Buffer = signMessage(seedHex, bytes);
  return { task, task_sig: sig.toString('base64') };
}

function selftest(): number {
  const vectors = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'verdict-vectors.json'), 'utf8')) as { owner_task: Record<string, unknown> };
  const v = vectors.owner_task;
  const task = OwnerTask.parse({
    tag: v.tag,
    task_id: v.task_id,
    contract_id: v.contract_id,
    agent_id: v.agent_id,
    plan_sha256: v.plan_sha256,
    instruction_sha256_salted: v.instruction_sha256_salted,
    issued_ms: v.issued_ms,
    expires_ms: v.expires_ms,
    max_actions: v.max_actions,
    bounds: v.bounds,
  });
  const borshHex = Buffer.from(ownerTaskBorsh(task)).toString('hex');
  if (borshHex !== v.borsh_hex || taskHash(task) !== v.sha256_hex) {
    process.stdout.write('task bytes MISMATCH\n');
    return 1;
  }
  const signed = signTask(task, String(v.seed_hex));
  const got = Buffer.from(signed.task_sig, 'base64').toString('hex');
  if (got !== v.signature_hex) {
    process.stdout.write(`signature MISMATCH: got ${got}\n`);
    return 1;
  }
  process.stdout.write('signature matches owner_task vector\n');
  return 0;
}

function main(argv: string[]): number {
  if (argv.length === 1 && argv[0] === '--selftest') return selftest();
  let text: string;
  if (argv.length === 0) text = readFileSync(0, 'utf8');
  else if (argv.length === 2 && argv[0] === '--file') text = readFileSync(argv[1] ?? '', 'utf8');
  else {
    process.stderr.write('usage: sign-task.ts [--file <path>] | --selftest   (task JSON on stdin without --file)\n');
    return 2;
  }
  const task = OwnerTask.parse(JSON.parse(text));
  const signed = signTask(task, loadSeedHex());
  process.stdout.write(JSON.stringify({ task: signed.task, task_sig: signed.task_sig }) + '\n');
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}

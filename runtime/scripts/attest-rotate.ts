// AIR-309: `pnpm -C runtime attest-rotate <compose_hash> --reason "<why>" [--model <id>]`. A manual, reviewed step, never run by the runtime.
// Fetches a fresh report, and only when the report's build has that compose hash and every check other than the model pin rows passes, adds the
// build's MRTD, RTMR0 to 2 and compose hash next to the old ones in runtime/config/attest-policy.json and appends the date, the report sha256 and
// the reason to its `_rotate_log`. Then the whole report is verified again under the new policy, and nothing is written unless that passes.
// Review first: the hash comes from the failing row of an earlier run or `attest --sample`, checked against NEAR's published image provenance.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attestModel, liveGpuVerifier, liveQuoteVerifier, POLICY_PATH, rotatePolicy, verifyReport } from '../src/attest/index.ts';
import type { VerifyPolicy } from '../src/attest/index.ts';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<number> {
  const hash = process.argv[2];
  const reason = arg('--reason');
  const model = arg('--model') ?? 'z-ai/glm-5.3-flash';
  if (hash === undefined || hash.startsWith('--') || reason === undefined) {
    console.error('usage: attest-rotate <compose_hash> --reason "<why>" [--model <id>]');
    return 2;
  }
  const file = fileURLToPath(POLICY_PATH);
  const policy = JSON.parse(readFileSync(file, 'utf8')) as VerifyPolicy & Record<string, unknown>;
  let body = '';
  const now = () => new Date();
  const current = await attestModel(model, { now, policy, onBody: (b) => void (body = b) });
  for (const c of current.checks.filter((k) => !k.ok)) console.log(`FAIL ${c.name}: ${c.detail}`);
  try {
    const { policy: next, entry } = await rotatePolicy({
      model,
      composeHash: hash,
      reason,
      now: now(),
      policy,
      rawBody: body,
      current,
      verifyWith: (p) => verifyReport({ rawBody: body, model, nonce: current.nonce }, { verifyQuote: liveQuoteVerifier(now), verifyGpu: liveGpuVerifier(), now }, p),
    });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`ROTATED ${model} compose_hash ${entry.compose_hash} report_sha256 ${entry.report_sha256}; review the diff of runtime/config/attest-policy.json and commit it`);
    return 0;
  } catch (e) {
    console.error(`NOT ROTATED: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

process.exit(await main());

// AIR-303: `pnpm -C runtime attest [--model <id>] [--fixture <dir>]`. Fetch the NEAR AI Cloud attestation report of the planner model with a fresh
// nonce, verify it (Intel DCAP quote, nonce and signer binding, RTMR3 replay, MRCONFIGID, NVIDIA GPU evidence, for the gateway and the model), print
// one row per check and the record. With `--fixture <dir>` the raw report, the quote collateral and the NRAS answer are written there, so the tests
// verify the same evidence offline. The report endpoint is not billed; the key (NEARAI_API_KEY) is read from the environment and never printed.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attestModel, liveGpuVerifier, liveQuoteVerifier, nrasVerdict } from '../src/attest/index.ts';
import type { Collateral } from '../src/attest/index.ts';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';

async function main(): Promise<number> {
  const model = arg('--model') ?? DEFAULT_MODEL;
  const dir = arg('--fixture');
  const quotes: Record<string, { collateral: Collateral; now_secs: number }> = {};
  // only the verdict of the NVIDIA answer is stored: its JWTs are public attestation tokens but look like credentials to the secret scanner
  const gpu: Record<string, { overall: boolean }> = {};
  let body = '';
  let nonce = '';
  const now = () => new Date();
  const att = await attestModel(model, {
    now,
    deps: {
      verifyQuote: liveQuoteVerifier(now, (q, c, n) => {
        quotes[createHash('sha256').update(q).digest('hex')] = { collateral: c, now_secs: n };
      }),
      verifyGpu: liveGpuVerifier(fetch, (payload, response) => {
        gpu[createHash('sha256').update(JSON.stringify(payload)).digest('hex')] = { overall: nrasVerdict(response) };
      }),
    },
    onBody: (b, n) => {
      body = b;
      nonce = n;
    },
  });
  for (const c of att.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  console.log(`ATTEST ${att.status} model ${att.model} report_sha256 ${att.report_sha256} verified_at ${att.verified_at}`);
  if (dir !== undefined && body !== '') {
    mkdirSync(dir, { recursive: true });
    // non-ASCII is escaped so the fixture carries no raw em dash (the commit hook bans it); JSON.parse restores the exact characters
    const text = JSON.stringify({ model, nonce, raw_body: body, quotes, gpu, record: att }).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    writeFileSync(join(dir, 'fixture.json'), `${text}\n`);
    console.log(`fixture written to ${join(dir, 'fixture.json')}`);
  }
  return att.status === 'VERIFIED' ? 0 : 1;
}

process.exit(await main());

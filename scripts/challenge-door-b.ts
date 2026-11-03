// Door (b) as a challenger: hold exactly what a compromised agent holds (the published function-call key and the owner-signed task from the
// state API) and call `submit_batch` on the challenge policy. Testnet only; the secret key is read from CHALLENGE_KEY_SECRET and never printed.
//   set -a; . ~/.airlock-challenge.env; set +a
//   pnpm tsx scripts/challenge-door-b.ts --payee <key> --amount <NEAR decimal> [--index N] [--url http://127.0.0.1:8788]
// The request claims Owner labels on the recipient and the amount, the strongest lie a compromised agent can tell; the contract decides.
import { ChainClient } from '../runtime/src/chain/near.ts';
import { DEFAULT_RPC_URLS, RpcPool } from '../runtime/src/chain/rpc.ts';
import { signerFromSecret } from '../runtime/src/chain/signer.ts';
import { LiveTransport } from '../runtime/src/chain/transport.ts';
import { OwnerTask } from '../runtime/src/dsl/index.ts';
import { toBaseUnits } from '../runtime/src/money/index.ts';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

async function main(): Promise<void> {
  const secret = process.env['CHALLENGE_KEY_SECRET'];
  const agent = process.env['CHALLENGE_AGENT_ACCOUNT'];
  const policy = process.env['CHALLENGE_POLICY_ACCOUNT'];
  if (secret === undefined || agent === undefined || policy === undefined) throw new Error('source the challenge env file first');
  const state = (await (await fetch(`${arg('url', 'http://127.0.0.1:8788')}/api/challenge/state`)).json()) as { task: { task: unknown; task_sig: string } | null };
  if (state.task === null) throw new Error('the state API publishes no task');
  const task = OwnerTask.parse(state.task.task);
  const signer = signerFromSecret(secret);
  const pool = new RpcPool(DEFAULT_RPC_URLS);
  const chain = new ChainClient({ network: 'testnet', contractId: policy, agentAccountId: agent, signer, transport: new LiveTransport({ contractId: policy, agentAccountId: agent, signer, pool }) });
  const payee = arg('payee');
  const hex = '0'.repeat(64);
  const res = await chain.submitBatch(
    [
      {
        task_id: task.task_id,
        action_index: Number(arg('index', '0')),
        asset: 'near',
        payee,
        amount: toBaseUnits(arg('amount'), 24).toString(),
        labels: { recipient: 1, amount: 1, pc: 1 },
        evm: null,
        hints: { plan_hash: task.plan_sha256, trace_digest: hex },
      },
    ],
    task,
    new Uint8Array(Buffer.from(state.task.task_sig, 'base64')),
  );
  for (const o of res.outcomes) console.log(JSON.stringify({ payee, outcome: o.outcome, reason: o.reason, tx: res.txHash }));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.slice(0, 300) : 'failed');
  process.exitCode = 1;
});

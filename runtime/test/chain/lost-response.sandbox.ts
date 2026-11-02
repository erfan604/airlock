// AIR-160 sandbox test 6: the lost response. A proxy in front of the sandbox destroys the socket of every `send_tx` after the sandbox
// answered, so the batch executed and the client never heard. The client must find it by reading the requests back, not by sending again.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainClient } from '../../src/chain/near.ts';
import { taskHash } from '../../src/dsl/index.ts';
import type { ActionRequest, OwnerTask } from '../../src/dsl/index.ts';
import { startWorld } from '../helpers/sandbox.ts';
import type { SandboxWorld } from '../helpers/sandbox.ts';

let world: SandboxWorld;
let client: ChainClient;

const NEAR = 10n ** 24n;

before(async () => {
  world = await startWorld({ dropSendTxReplies: true });
  client = new ChainClient({
    network: 'testnet',
    contractId: world.policyId,
    agentAccountId: world.agentId,
    signer: world.agentSigner,
    rpcUrls: world.rpcUrls,
    pollMs: 200,
    windowMs: 15000,
  });
});
after(async () => {
  await world.stop();
});

test('6. a lost send_tx reply: recovered inside the poll window, one stored request, one charge, at most two sends with the same bytes', async () => {
  const now = await client.latestBlockMs();
  const task: OwnerTask = {
    tag: 'airlock-task-v1',
    task_id: 'lost-response-1',
    contract_id: world.policyId,
    agent_id: world.agentId,
    plan_sha256: 'a'.repeat(64),
    instruction_sha256_salted: 'b'.repeat(64),
    issued_ms: now - 1000,
    expires_ms: now + 30 * 60 * 1000,
    max_actions: 5,
    bounds: [{ payee_key: `near:${world.payeeId}`, max_total: (1000n * NEAR).toString() }],
  };
  const req: ActionRequest = {
    task_id: task.task_id,
    action_index: 0,
    asset: 'near',
    payee: `near:${world.payeeId}`,
    amount: NEAR.toString(),
    labels: { recipient: 2, amount: 1, pc: 1 },
    evm: null,
    hints: { plan_hash: task.plan_sha256, trace_digest: '0'.repeat(64) },
  };
  const result = await client.submitBatch([req], task, world.signTask(task));
  assert.equal(result.recovered, true);
  assert.equal(result.txHash, null);
  assert.equal(result.outcomes[0]?.outcome, 'allowed');
  assert.equal(world.sentTxs.length >= 1 && world.sentTxs.length <= 2, true, `${world.sentTxs.length} send_tx requests`);
  assert.equal(new Set(world.sentTxs).size, 1, 'every send carried the same signed_tx_base64');
  assert.ok(world.sentTxs[0] !== '' && world.sentTxs[0] !== undefined);

  const view = await client.getRequest(`${taskHash(task)}:0`);
  assert.ok(view);
  assert.ok(view.state === 'Executing' || view.state === 'Executed');
  const ledgers = await client.getLedgers(`near:${world.payeeId}`, 'near', taskHash(task));
  assert.equal(ledgers.task_spent, NEAR.toString(), 'one charge');
  assert.equal(ledgers.payee_day.spent, NEAR.toString());
});

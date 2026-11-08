// The sandbox world of the chain client's tests (AIR-160; AIR-161 and AIR-165 reuse it): a local neard from near-sandbox, the policy
// contract and the mock MPC deployed under test.near, an agent registered and allowed, the task key and one asset and one book payee
// set. Everything goes through near-api-js. Needs the contract wasm (`cargo near build non-reproducible-wasm --no-abi`) and
// NEAR_SANDBOX_BIN_PATH from scripts/env.sh (without it the package downloads another neard).
import { createHash, createPrivateKey, sign as ed25519Sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, nearToYocto, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { Sandbox } from 'near-sandbox';
import { ownerTaskBorsh } from '../../src/dsl/index.ts';
import type { OwnerTask } from '../../src/dsl/index.ts';
import { Vault } from '../../src/vault/index.ts';

export interface SandboxWorld {
  /** the sandbox's own RPC URL */
  rpcUrl: string;
  /** the URLs a client should use: the sandbox, or the lossy proxy in front of it */
  rpcUrls: string[];
  ownerId: string;
  policyId: string;
  agentId: string;
  mpcId: string;
  payeeId: string;
  /** AIR-326: the owner's private book (one payee, `Payee`); the contract holds only its root */
  vault: Vault;
  agentSigner: KeyPairSigner;
  /** the agent's secret key, for a test that writes a credentials file (AIR-313); never printed */
  agentKey: KeyPairString;
  /** an owner call with 1 yoctoNEAR (every owner method of the product contract demands exactly that) */
  ownerCall(method: string, args: object): Promise<void>;
  /** the owner's Ed25519 signature over the borsh bytes of the task, with the seed of 32 bytes of 01 (no prefix) */
  signTask(task: OwnerTask): Uint8Array;
  /** `signed_tx_base64` of every `send_tx` the lossy proxy saw (empty without `dropSendTxReplies`) */
  sentTxs: string[];
  stop(): Promise<void>;
}

const REPO_ROOT = new URL('../../../', import.meta.url);
const TASK_SEED = new Uint8Array(32).fill(1);
const TASK_PUBLIC_KEY = 'ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
// the fixed PKCS8 prefix of an Ed25519 private key; the 32 byte seed follows
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function policyWasm(): Buffer {
  const target = process.env.CARGO_TARGET_DIR ?? join(REPO_ROOT.pathname, 'contracts/airlock-policy/target');
  return readFileSync(join(target, 'near/airlock_policy.wasm'));
}

const mockMpcWasm = (): Buffer => readFileSync(new URL('contracts/airlock-policy/tests/contracts/mock_mpc.wasm', REPO_ROOT));

const localMode = (): { approve_measurements: object; approve_ppids: object; register_agent: object } =>
  JSON.parse(readFileSync(new URL('../fixtures/local-mode.json', import.meta.url), 'utf8')) as { approve_measurements: object; approve_ppids: object; register_agent: object };

// the first 12 lowercase hex characters of the sha256 of the account id (AIR-046)
const fingerprint = (accountId: string): string => createHash('sha256').update(accountId).digest('hex').slice(0, 12);

const near = (amount: string): string => nearToYocto(amount as `${number}`).toString();

interface LossyProxy {
  url: string;
  sentTxs: string[];
  close(): Promise<void>;
}

// A proxy in front of the sandbox RPC: it forwards every request and, for the JSON-RPC method `send_tx`, destroys the socket after the
// sandbox answered, so the transaction executed and the reply was lost. A client that retries is dropped on every retry.
async function startLossyProxy(target: string): Promise<LossyProxy> {
  const sentTxs: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      let method = '';
      try {
        const parsed = JSON.parse(body.toString('utf8')) as { method?: string; params?: { signed_tx_base64?: string } };
        method = parsed.method ?? '';
        if (method === 'send_tx') sentTxs.push(parsed.params?.signed_tx_base64 ?? '');
      } catch {
        // forwarded untouched
      }
      const upstream = httpRequest(target, { method: 'POST', headers: { 'content-type': 'application/json' } }, (answer) => {
        const parts: Buffer[] = [];
        answer.on('data', (chunk: Buffer) => parts.push(chunk));
        answer.on('end', () => {
          if (method === 'send_tx') {
            request.socket.destroy();
            return;
          }
          const out = Buffer.concat(parts);
          response.writeHead(answer.statusCode ?? 200, { 'content-type': 'application/json', 'content-length': out.length });
          response.end(out);
        });
      });
      upstream.on('error', () => request.socket.destroy());
      upstream.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    sentTxs,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function startWorld(opts: { dropSendTxReplies?: boolean } = {}): Promise<SandboxWorld> {
  const sandbox = await Sandbox.start({});
  let proxy: LossyProxy | null = null;
  try {
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl }, { retries: 3, wait: 250, backoff: 2 });
    for (;;) {
      if ((await provider.viewBlock({ finality: 'final' })).header.height >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // neard's own account: its key is in validator_key.json under `secret_key` (not `private_key`)
    const validator = JSON.parse(readFileSync(join(sandbox.homeDir, 'validator_key.json'), 'utf8')) as { account_id: string; secret_key: string };
    const root = new Account(validator.account_id, provider, KeyPairSigner.fromSecretKey(validator.secret_key as KeyPairString));
    const ownerId = validator.account_id;

    const make = async (name: string, nearAmount: string): Promise<{ id: string; account: Account; signer: KeyPairSigner; secret: KeyPairString }> => {
      const id = `${name}.${ownerId}`;
      const key = KeyPair.fromRandom('ed25519');
      await root.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(nearAmount as `${number}`) });
      const signer = new KeyPairSigner(key);
      return { id, account: new Account(id, provider, signer), signer, secret: key.toString() as KeyPairString };
    };
    const policy = await make('policy', '100');
    const mpc = await make('mpc', '10');
    const agent = await make('agent', '10');
    const payee = await make('payee', '1');

    await policy.account.signAndSendTransaction({
      receiverId: policy.id,
      waitUntil: 'FINAL',
      actions: [
        actions.deployContract(policyWasm()),
        actions.functionCall(
          'new',
          { requires_tee: false, attestation_expiration_time_ms: '86400000', owner_id: ownerId, mpc_contract_id: mpc.id },
          teraToGas(100),
          0n,
        ),
      ],
    });
    await mpc.account.signAndSendTransaction({
      receiverId: mpc.id,
      waitUntil: 'FINAL',
      actions: [actions.deployContract(mockMpcWasm()), actions.functionCall('new', {}, teraToGas(30), 0n)],
    });

    const ownerCall = async (method: string, args: object): Promise<void> => {
      await root.callFunctionRaw({ contractId: policy.id, methodName: method, args, gas: teraToGas(100), deposit: 1n, waitUntil: 'FINAL' });
    };
    const mode = localMode();
    await ownerCall('approve_measurements', mode.approve_measurements);
    await ownerCall('approve_ppids', mode.approve_ppids);
    await ownerCall('whitelist_agent_for_local', { account_id: agent.id });
    await agent.account.callFunctionRaw({
      contractId: policy.id,
      methodName: 'register_agent',
      args: mode.register_agent,
      gas: teraToGas(300),
      deposit: nearToYocto('0.005'),
      waitUntil: 'FINAL',
    });
    await ownerCall('allow_agent', { account_id: agent.id, fingerprint: fingerprint(agent.id) });
    await ownerCall('set_task_key', { public_key: TASK_PUBLIC_KEY });
    await ownerCall('asset_set', {
      asset: 'near',
      entry: {
        symbol: 'NEAR',
        decimals: 24,
        hard_cap: near('10000'),
        daily_cap: near('100000'),
        max_fee_per_gas: '0',
        max_gas: '0',
        quick_task_cap: near('100000'),
        path: null,
      },
    });
    // AIR-326: the book is a root; the vault builds it and the runtime keeps the entry's proof
    const vault = Vault.empty().add({
      payee: `near:${payee.id}`,
      cap: BigInt(near('100')),
      dailyUntrustedBudget: BigInt(near('1000')),
      dailyLimit: BigInt(near('5000')),
      label: 'Payee',
      listed: true,
    });
    await ownerCall('book_set_root', { expected_old: '0'.repeat(64), new_root: vault.root() });

    if (opts.dropSendTxReplies === true) proxy = await startLossyProxy(sandbox.rpcUrl);
    const taskKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, TASK_SEED]), format: 'der', type: 'pkcs8' });
    const lossy = proxy;
    return {
      rpcUrl: sandbox.rpcUrl,
      rpcUrls: [lossy === null ? sandbox.rpcUrl : lossy.url],
      ownerId,
      policyId: policy.id,
      agentId: agent.id,
      mpcId: mpc.id,
      payeeId: payee.id,
      vault,
      agentSigner: agent.signer,
      agentKey: agent.secret,
      ownerCall,
      signTask: (task) => new Uint8Array(ed25519Sign(null, ownerTaskBorsh(task), taskKey)),
      sentTxs: lossy === null ? [] : lossy.sentTxs,
      stop: async () => {
        if (lossy !== null) await lossy.close();
        await sandbox.tearDown();
      },
    };
  } catch (error) {
    if (proxy !== null) await proxy.close();
    await sandbox.tearDown();
    throw error;
  }
}

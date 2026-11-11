// AIR-356: a try card public file for tests (the real one is fetched from the site at run time and never committed).
import type { TryPublic } from '../../src/live/tryPublic.ts';
import vector from './tx-vector.json' with { type: 'json' };

export const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const OWNER_ACC = 'airlock-try-a1b2c3.testnet';
export const POLICY = `try.${OWNER_ACC}`;
export const AGENT = `agent.${OWNER_ACC}`;
export const SHOP = `near:shop.${OWNER_ACC}`;
export const PROOF = { salt: 'd'.repeat(64), cap: null, daily_untrusted_budget: '0', daily_limit: '300000000000000000000000', index: 0, siblings: ['e'.repeat(64)] };
const task = (k: number): TryPublic['tasks'][number] => ({
  task: { tag: 'airlock-task-v1', task_id: `try-${String(k)}-1`, contract_id: POLICY, agent_id: AGENT, plan_sha256: 'a'.repeat(64), instruction_sha256_salted: 'b'.repeat(64), issued_ms: NOW - 1000, expires_ms: NOW + 86_400_000, max_actions: 99, bounds: [{ payee_key: SHOP, max_total: '10000000000000000000000' }] },
  task_sig: Buffer.from(new Uint8Array(64)).toString('base64'),
  task_hash: String(k).repeat(64).slice(0, 64),
  issuedAt: '',
  expiresAt: '',
});
export const PUB: TryPublic = {
  format: 'airlock-try-public-v1',
  policy: POLICY,
  agent: AGENT,
  keys: [
    { publicKey: vector.publicKey, secretKey: vector.secretKey },
    { publicKey: vector.publicKey, secretKey: vector.secretKey },
    { publicKey: vector.publicKey, secretKey: vector.secretKey },
  ],
  shop: { payee: SHOP, proof: PROOF },
  book: [SHOP],
  pendingTtlMs: 60_000,
  honestAmount: '1000000000000000000000',
  publishedAt: '',
  tasks: [task(1), task(2)],
};


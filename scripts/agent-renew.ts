// Renewing an agent's attestation on its policy, as a dry run. An agent may submit only while its registration is valid; register_agent
// (signed by the agent itself) sets the end to the block time plus the policy's attestation lifetime, 14 days on both policies here. The
// /challenge agent's registration ends 2026-11-17 and the credit agent's 2026-11-23; both must outlast Nov 25. This script reads the chain
// and prints, for each agent, where it stands and the exact near CLI commands that renew it. It sends nothing and has no sending path.
//   pnpm tsx scripts/agent-renew.ts                    the plan for both agents and the commands (not sent)
//   pnpm tsx scripts/agent-renew.ts --verify           read only: AGENT RENEW OK per agent, exit 1 if either does not outlast the date
//   --until <ISO time>                                 the date to outlast (default 2026-11-26T00:00:00Z)
// Run the printed commands from the repo root (the register_agent argument is read from fixtures/local-mode.json with jq).
import { fileURLToPath } from 'node:url';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import { DEFAULT_UNTIL_MS, RENEW_TARGETS, mayCall, renewPlan, renewVerify } from '../runtime/src/credit/renew.ts';
import type { AgentFacts, RenewTarget } from '../runtime/src/credit/renew.ts';
import { rpcKeys, rpcView } from '../runtime/src/credit/rpc.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const msOf = (v: unknown): number => {
  if (typeof v !== 'string' || !/^[0-9]{1,16}$/.test(v)) throw new Error('a policy view answered something unexpected');
  // a time or a lifetime in ms: far below 2^53
  return +v;
};

async function factsOf(t: RenewTarget): Promise<AgentFacts> {
  const rpc = DEFAULT_RPC_URLS[0] ?? 'https://test.rpc.fastnear.com';
  const info = await rpcView(rpc, t.policy, 'get_contract_info', {});
  if (!isObj(info)) throw new Error('get_contract_info answered something unexpected');
  const agent = await rpcView(rpc, t.policy, 'get_agent', { account_id: t.agent });
  const keys = await rpcKeys(rpc, t.agent);
  return {
    ...t,
    validUntilMs: isObj(agent) ? msOf(agent['valid_until_ms']) : null,
    valid: isObj(agent) && agent['validity'] === 'Valid',
    lifetimeMs: msOf(info['attestation_expiration_time_ms']),
    canRegister: keys.some((k) => mayCall(k.permission, t.policy, 'register_agent')),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let untilMs = DEFAULT_UNTIL_MS;
  let verify = false;
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    if (argv[i] === '--verify') verify = true;
    else if (argv[i] === '--until' && next !== undefined && !Number.isNaN(Date.parse(next))) untilMs = Date.parse(argv[(i += 1)] ?? '');
    else {
      console.log('usage: agent-renew.ts [--until <ISO time>] [--verify]');
      return 2;
    }
  }
  let code = 0;
  for (const t of RENEW_TARGETS) {
    const f = await factsOf(t);
    if (verify) {
      const v = renewVerify(f, untilMs);
      console.log(v.line);
      code = Math.max(code, v.code);
      continue;
    }
    const plan = renewPlan(f, Date.now(), untilMs);
    for (const l of plan.lines) console.log(l);
    for (const c of plan.commands) console.log(`  ${c}`);
  }
  if (!verify) console.log('AGENT RENEW DRY: nothing was sent; after sending, check with: pnpm tsx scripts/agent-renew.ts --verify');
  return code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`AGENT RENEW FAILED ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

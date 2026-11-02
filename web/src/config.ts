// The console's build-time configuration (AIR-185). `VITE_AGENT_ACCOUNT_ID` and `VITE_CONTRACT_ID` are required and the console throws at
// start-up without them. `runtimeOrigin` feeds the CSP only: the console reaches the runtime by a relative URL through the preview proxy.
import { NEAR_RPC } from '../csp.ts';

export type ConsoleConfig = { contractId: string; agentId: string; runtimeOrigin: string; rpcUrls: string[]; network: 'testnet' };

type Env = Record<string, string | undefined>;

/** `env` defaults to `import.meta.env`; a test passes its own. */
export function consoleConfig(env: Env = import.meta.env as Env): ConsoleConfig {
  const contractId = env.VITE_CONTRACT_ID;
  const agentId = env.VITE_AGENT_ACCOUNT_ID;
  if (contractId === undefined || contractId === '') throw new Error('VITE_CONTRACT_ID is not set');
  if (agentId === undefined || agentId === '') throw new Error('VITE_AGENT_ACCOUNT_ID is not set');
  const origin = env.VITE_RUNTIME_ORIGIN;
  return { contractId, agentId, runtimeOrigin: origin === undefined || origin === '' ? 'http://localhost:8787' : origin, rpcUrls: [...NEAR_RPC], network: 'testnet' };
}

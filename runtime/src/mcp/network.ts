// AIR-322 (H1): the boot-time proof that the RPC is NEAR testnet. A hostname list cannot tell a mainnet endpoint from a testnet one, so every
// configured RPC (or the default testnet list) is asked for `status` and its chain_id must be `testnet`. A sandbox config is already limited
// to loopback RPCs by parseConfig and is not asked. If no RPC answers, the server does not start (fail closed).
import { DEFAULT_RPC_URLS } from '../chain/rpc.ts';
import { ConfigError } from './config.ts';
import type { McpConfig } from './config.ts';

const TIMEOUT_MS = 8000;

async function chainId(url: string, f: typeof fetch): Promise<string | null> {
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'airlock', method: 'status', params: [] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { chain_id?: unknown } };
    return typeof body.result?.chain_id === 'string' ? body.result.chain_id : null;
  } catch {
    return null;
  }
}

export async function assertTestnetNetwork(cfg: McpConfig, f: typeof fetch = fetch): Promise<void> {
  if (cfg.network !== 'testnet') return;
  const urls = cfg.rpc ?? [...DEFAULT_RPC_URLS];
  const ids = await Promise.all(urls.map((u) => chainId(u, f)));
  let answered = 0;
  ids.forEach((id, i) => {
    if (id === null) return;
    answered += 1;
    if (id !== 'testnet') throw new ConfigError(`testnet only: ${new URL(urls[i] as string).host} is not testnet (chain_id ${id.slice(0, 32)})`);
  });
  if (answered === 0) throw new ConfigError('testnet only: could not confirm the network, no configured RPC answered status');
}

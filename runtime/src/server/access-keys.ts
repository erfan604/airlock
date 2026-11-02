// The owner's on-chain keys, read through the RPC pool (AIR-160). It sits on RpcPool and not on a failover provider: a pool that wraps
// FailoverRpcProvider turns a missing key into RetriesExceeded, and a missing key is an answer (null), not an outage.
import { AccessKeyDoesNotExistError, AccountDoesNotExistError, RpcError } from 'near-api-js/rpc-errors';
import type { RpcPool } from '../chain/rpc.ts';

/** `null` when the key is not on the account. */
export type AccessKeyReader = (accountId: string, publicKey: string) => Promise<{ permission: 'FullAccess' | 'FunctionCall' } | null>;

/** Every RPC URL failed: the login cannot be decided. Never a statement about the key. */
export class RpcUnavailable extends Error {
  constructor(message = 'every rpc url failed') {
    super(message);
    this.name = 'RpcUnavailable';
  }
}

export function rpcAccessKeyReader(pool: RpcPool): AccessKeyReader {
  return async (accountId, publicKey) => {
    let key: { permission: unknown };
    try {
      key = await pool.run((provider) => provider.viewAccessKey({ accountId, publicKey }));
    } catch (error) {
      if (error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError) return null;
      // the pool rethrows a node's own answer as it is; what is left after the last URL is a transport failure
      if (error instanceof RpcError) throw error;
      throw new RpcUnavailable();
    }
    return { permission: key.permission === 'FullAccess' ? 'FullAccess' : 'FunctionCall' };
  };
}

// The two error classes of the chain client. Messages never contain a key or a signature.

export type ChainErrorCode = 'BadBatch' | 'RequestMismatch' | 'NotRetryable' | 'Panic' | 'BadResponse' | 'IdMismatch' | 'Unknown' | 'ReplayMiss' | 'BookStale';

/**
 * A refusal or a failure of one chain call. `Panic` is a contract refusal (never retried), `RequestMismatch` a bug in the caller,
 * `Unknown` an outcome that stayed unknown after the two sends the client allows itself, `ReplayMiss` a replay transport asked
 * for something that was not recorded, `BookStale` the owner's vault root is not the root the contract holds (AIR-326).
 */
export class ChainError extends Error {
  constructor(
    readonly code: ChainErrorCode,
    message: string,
    readonly txHash: string | null = null,
  ) {
    super(message);
    this.name = 'ChainError';
  }
}

export type ChainWaitCode = 'Timeout' | 'Failed' | 'NotSigned';

/** `waitSigned` ended without a signature: `retryable` is true for a request the contract moved to Retryable. */
export class ChainWaitError extends Error {
  constructor(
    readonly code: ChainWaitCode,
    message: string,
    readonly reason: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ChainWaitError';
  }
}

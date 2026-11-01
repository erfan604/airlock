# Decision AIR-104: the EVM nonce is contract state

The contract owns the EVM nonce of each derivation path (the `path` of an EVM asset in the registry, for example `base-sepolia-1`).
The runtime cannot choose a nonce, so it cannot make the contract sign two transactions for one request.

## What the contract stores

- `nonces`: for each registry path, the next nonce to hand out. The owner sets it with `set_nonce(path, nonce)`, because the chain's
  count is unknown to the contract. `get_nonce(path)` reads it (`null` when never set).
- `evm_attempts`: for each request id, the one transaction it was signed as: the path, the nonce and the unsigned transaction bytes.
  The first signing attempt of a request records it, and the record is never replaced and never removed.

## Rules

1. `next_nonce` returns the stored value and stores it plus one. It reverts `nonce not set` when the owner never set a value, and
   `nonce overflow` when the stored value is `u64::MAX` (EIP-2681 caps a nonce at 2^64 - 2, so `u64::MAX - 1` is the last value issued).
2. The counter is never decremented by the contract, even when the signing that used the nonce fails later, because signatures for
   later nonces may already exist.
3. A retry reuses the first attempt's nonce and bytes and takes no new nonce. One request id therefore produces at most one
   transaction, even when an MPC signature that looked like a failure (a timeout answered late, a response our parser refused)
   reaches the chain afterwards.
4. `set_nonce` is the only way to move the counter down. It is an owner method (one yoctoNEAR) and reverts `unknown path` unless a
   registered asset has that path.

## What goes wrong, and the recovery

- A signature that is issued but never broadcast blocks later nonces on that path: the chain waits for the missing nonce, so every
  later transaction on the path stays pending. Recovery: `set_nonce` to the chain's pending count for the address, or register a new
  path.
- A failed signing that is never retried leaves the same hole, because its nonce was taken and no transaction exists for it. Recovery
  is the same. A signing that is retried fills the hole, because the retry re-signs the first attempt under the same nonce.
- An external transaction from the same address (sent outside the contract) moves the chain's count past the stored value. Recovery:
  `set_nonce` to the chain's count.
- Lowering the counter below the stored nonce of an outstanding Retryable request lets another request sign the same nonce, and only one
  of the two transactions can ever execute. Lower it only when no Retryable request of that path is outstanding.
- The contract never decrements the counter, so a lowered value is always an owner decision and the `nonce_set` event records it.

## Cost

Entries of `evm_attempts` are never removed. They are bounded by the EVM requests the owner's tasks admit, about 0.003 NEAR each in
storage; AIR-049's storage budget counts them.

## Not here

Using the nonce in a transaction is AIR-100. EVM cancel by a zero-value replacement is deferred (AIR-110 holds the design). Reading
the chain's nonce is done by AIR-049 and AIR-102.

# Deferred design AIR-110: cancel an EVM signature by zero-value replacement

Status: designed, not built. The ignored test `evm_cancel_zero_value_replacement_at_same_nonce` in
`contracts/airlock-policy/tests/deferred.rs` states the assertions. The shipped behavior is pinned by `no_cancel_method_is_exported`.

README sentence: An issued signature that is never broadcast blocks later nonces for that path; use `set_nonce` or a new path.

## The problem

A signed EVM transaction never expires. The chain accepts it at any later time while its nonce is the next one for the sender.
Revoking an agent, pausing the contract or rejecting a request later does not recall a signature that already left the contract: only
consuming the nonce cancels it. Two cases follow.

- A signature is issued and never broadcast. The chain waits for that nonce, so every later transaction on the path stays pending.
- A signature is issued, the owner no longer wants the payment, and a holder of the signature can still broadcast it.

## Design

`cancel(request_id)`, owner only, 1 yoctoNEAR:

1. Read the request's `evm_attempts` record (path, nonce, unsigned bytes, fees). A request with no record, or one that already
   executed or was cancelled, reverts.
2. Build a zero-value transaction from the same sender to the sender itself, same chain id, same path, same nonce, gas limit 21000,
   with `max_fee_per_gas` and `max_priority_fee_per_gas` at least 10 percent above the first attempt (the usual replacement rule of
   nodes, so the replacement wins the mempool slot).
3. Sign it through a second MPC call. This is the second MPC path: a callback of its own, its own `Cancelled` state, its own retry
   and timeout handling, and its own refund rule for the ledgers (the original charge is refunded once, never twice).
4. Emit `cancelled` with the request id, path, nonce and the replacement hash. The owner broadcasts the replacement.

Cancel is best effort. If the original was already broadcast and mined, the replacement is rejected by the chain with a nonce error
and the payment stands. If both are in the mempool, the higher fee wins.

## Why it is cut

Estimated 4 to 6 hours: a second MPC callback with failure handling, fee bump rules per chain, a new request state with ledger
refund and idempotency proofs, sandbox tests for each ordering, and a Kani harness for the refund. No demo needs it, and the demo
never leaves a signature unbroadcast. The state machine is the risk: a wrong refund would break the ledger claims, which is a worse
failure than a missing feature.

## Current recovery

- `set_nonce(path, nonce)` (owner, 1 yoctoNEAR, `docs/design/nonce.md`): set the counter to the chain's pending count for the address,
  then the next request takes the nonce the chain expects. If an old signature for a lower nonce is still held by someone, it can still
  be broadcast, so also treat the address as exposed.
- Or register a new path with `asset_set`: a new path derives a new address and a new nonce sequence. Fund it and leave the old
  address.

## Reference

Peerfolio's pen-test fix for the NEAR analogue is the model for the hardening: delete the key and keep a nonce ceiling below
`block_height * 1_000_000`. The EVM equivalent is nonce consumption, which this design does with the replacement transaction.

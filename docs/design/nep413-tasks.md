# Deferred design AIR-110: wallet-signed (NEP-413) tasks above the quick cap

Status: designed, not built. The ignored test `nep413_task_above_quick_cap_checked_from_wallet_signature` in
`contracts/airlock-policy/tests/deferred.rs` states the assertions. The shipped behavior is pinned by `task_above_quick_cap_reverts`.

README sentence: Tasks above the quick cap are not supported in this version.

## The shipped behavior

Each asset in the registry has an owner-set `quick_task_cap`. The contract holds one task key, set with `set_task_key`. A task signed
with that key must have every bound at or below the quick cap of its asset. A bound above it reverts `task above quick cap`
(`verify_bounds` in `src/task.rs`). There is no other way to authorize a larger task.

## Design

A task above the quick cap is signed in the owner's wallet with NEP-413 `signMessage`, so a human sees the amounts before signing.

1. The console builds the task struct (`OwnerTask`) and asks the wallet to sign a message.
2. The contract does not trust the text it is given. It regenerates the message text from the struct: the payee keys, each `max_total`
   rendered with the registry symbol and decimals of its asset (for example `up to 150.5 NEAR to near:alice.testnet`), the agent, the
   expiry and the action count. The signed text must equal the regenerated text byte for byte, so what the wallet shows is what the
   contract enforces.
3. The contract checks the NEP-413 payload: the tag, the recipient (this contract), a nonce that was not used before, and the
   signature over the sha256 of the borsh payload with the NEP-413 prefix.
4. A task above the quick cap with a task key signature still reverts. Standing tasks need the same path and are cut with it.

## Key registration problem

The signature must verify against a key the owner controls. A wallet signs with a function-call or full-access key of the owner's
account, and the contract needs that public key. The contract cannot read an account's access keys on chain. So the owner registers
the key with an owner call, in a wallet transaction that confirms it. A wallet that rotates keys, or signs `signMessage` with a key
that was never registered, produces a signature the contract rejects, and the failure looks to the owner like a broken wallet.

## Wallet `signMessage` variance

Wallets differ. Some sign with a fresh key per session, some refuse a long message, some show a hash instead of the text, and some
return a signature over a payload whose nonce or recipient they chose themselves. Each wallet needs a recorded test. A wallet that
shows a hash makes the regenerated text useless as a human check, which defeats the point.

## Why it is cut

Estimated 8 to 14 hours plus wallet variance: the text generator with decimal formatting that must match the TypeScript console
byte for byte, a shared vector set, NEP-413 verification in the contract, key registration with its owner method and events, replay
protection, and a recorded run on each wallet. The demo stays under the quick cap, so no demo needs it. A limited honest behavior
(a revert) is better than a half-checked wallet path.

## Current alternatives

- Raise the asset's `quick_task_cap` with `asset_set` (owner, wallet-confirmed). The cap can never exceed the daily cap.
- Split the work into several tasks at or below the cap. The daily cap and the per-payee limits still bound the total.

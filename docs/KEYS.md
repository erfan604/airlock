# Keys

What each account of the entry holds, read from NEAR testnet with the RPC call `view_access_key_list` (or `near account list-keys <account> network-config testnet now`). Re-read it yourself; the chain is the source, this page is a copy.

## The credit pool and card (read 2026-11-10, block 277036844)

| Account | Keys | What that means |
| --- | --- | --- |
| `agent.airlock-credit-c1108d.testnet` (the credit agent) | one full-access key and one function-call key: receiver `card.airlock-credit-c1108d.testnet`, methods `submit_batch` and `expire`, no allowance limit | the function-call key can send requests to the card and expire held ones; it cannot attach a deposit, add keys, deploy code or call an owner method. The full-access key is held by the team and can do anything the account can, including moving the agent account's own NEAR. |
| `card.airlock-credit-c1108d.testnet` (the card policy) | one full-access key | the deployer can redeploy the card's code. |
| `pool.airlock-credit-c1108d.testnet` (the pool) | one full-access key | the deployer can redeploy the pool's code, which could change its rules for the lenders' money. |

The function-call key does not limit what the agent submits: the agent can send any request, and the card's verdict decides each one (allow, hold for the owner, or block). The issuer `airlock-credit-c1108d.testnet` owns the card and the pool (it books payees, sets the limits and can approve a held payment); its keys are the team's. Removing the full-access keys of the agent, the card and the pool is not done: a redeploy stays possible, and a lender trusts the team not to use it.

Check: `near account list-keys agent.airlock-credit-c1108d.testnet network-config testnet now`, and the same for `card.` and `pool.`.

## The demo agent `erfan-agent.testnet` (read 2026-11-05)

Moved from the README. Checked on testnet on 2026-11-05 with `near account list-keys erfan-agent.testnet network-config testnet now` (or the RPC call `view_access_key_list`).

The agent account `erfan-agent.testnet` holds six access keys: five function-call keys, each limited to `submit_batch` on one policy account, and one full-access key used for setup. The function-call keys name `policy.erfan-airlock.testnet` (the golden runs' account, unlimited gas allowance because every call buys its gas up front and a capped allowance would lock the agent out), `policy-v3.erfan-airlock.testnet` (the live demo's account, capped allowance), `policy-v2.erfan-airlock.testnet` (the previous live demo account, capped allowance) and, with two keys of about 1 NEAR allowance each added by `scripts/challenge-setup.sh`, `challenge.erfan-airlock.testnet` (the challenge service's account). None of the five can move NEAR, add keys or call owner methods. They do not limit what the agent submits: the agent can still send any request, and the contract's verdict is the control.

- Receiver: of the six keys, five are function-call keys. One names `policy.erfan-airlock.testnet`, one names `policy-v3.erfan-airlock.testnet` (the account of the live demo, `pnpm demo:live`), one names `policy-v2.erfan-airlock.testnet` (the previous live demo account) and two name `challenge.erfan-airlock.testnet`; none names any other account. The sixth is the full-access key described below.
- Methods: `submit_batch`, and no other method, on each function-call key.
- Allowance: unlimited on the key for `policy.erfan-airlock.testnet`, about 5 NEAR on each of the keys for `policy-v3.erfan-airlock.testnet` and `policy-v2.erfan-airlock.testnet` and about 1 NEAR on each of the two challenge keys when checked. Every call buys its gas up front, and a capped allowance would lock the agent out when it runs low.
- It can: send requests to `submit_batch`. The contract's verdict decides each one: allow, escalate to you, or block. A request to a payee outside your book never passes on its own, and the card for it carries the counterparty note (`counterparty_new` when the account or address has no history, `counterparty_unverified` when it could not be checked). The note is a hint added by the runtime, not an input of the verdict.
- It cannot: attach a deposit, so it cannot move NEAR from the agent account through this key. It cannot add or delete keys, deploy code, call any other contract, or call an owner method (`approve`, `reject`, the book, the limits, `revoke_agent`), because the contract answers an owner method only to the owner.
- Not covered by the key: the agent account also holds a separate full-access key (the one listed as `FullAccess` by `view_access_key_list`), which is not a function-call key and is not handed to anyone. The key limits where a call can go, not what the agent submits.
- Revoke: the owner calls `revoke_agent` on the policy contract, which stops every later `submit_batch` from that account, and deletes the key with `near account delete-keys` using the account's full-access key.

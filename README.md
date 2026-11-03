# AIRLOCK

Provenance-gated signing for AI agent wallets on NEAR: a policy contract builds each transaction and asks the MPC signer for a signature when the owner's limits allow it or the owner approves the exact stored request.

## The problem

In May 2026 an AI agent's wallet was reported drained of $150K to $204K, depending on the source, after a public reply made Grok emit a command that Bankr's bot executed [S1]. Four multisig approval failures since July 2024 cost about $2.0 billion, and in the two with published mechanisms, Bybit and Radiant (about $1.5 billion), signers approved a screen that did not match what they signed [S2]. In Turnkey's simulated test, 48 of 50 warned agents paid an address that was swapped into their initial lookup, so a prompt warning does not help when the bad value arrives as trusted-looking data [S3].

## Proven

The payment gate is one small function, the verdict, and it is checked three ways: Lean theorems about a model of it [C7b], a Kani model check of the shipped Rust over every input each harness admits [C5], and a differential test in which the Lean model and the Rust code return the same answer on 40,000 generated cases [C7a]. In plain words, an allowed payment goes only to an address-book payee that the owner, the book or the policy named, inside the owner's caps, daily limit and task bound, and an amount read from untrusted text must also fit that payee's cap and untrusted budget [C5].

Not covered: the planner and reader models, the labels the runtime attaches to values, the TEE, the chain and the MPC signer, and the TypeScript interpreter (Lean covers a model of it and a property test covers the code). Each entry with its bound and its own not-covered line is in `docs/PROVEN.md`, and the console shows the same list at `/proven`. Recheck it with one command, `pnpm proven` (Rust 1.86, Kani 0.68 and Lean 4.35, about 5 minutes), which prints one line per entry and ends with `PROVEN OK <n> of <n>`.

## Try it in 2 minutes

`pnpm demo` needs Node 24 and pnpm only: no Rust and no keys. It replays recorded testnet runs and says so.

1. `pnpm i && pnpm demo`: see `console http://127.0.0.1:4173`, open it, and see the banner `Replay of recorded run`.
2. In the console, see a legitimate invoice paid with the stamp `ALLOWED`, an injected correction held with the stamp `HELD FOR YOU`, and after your tap the stamp `APPROVED BY YOU`.
3. Change one field of the approval and see `approve rejected: WrongAmount`.

`pnpm bench:replay` also needs Rust 1.86, because it builds the verdict CLI. It regenerates the results from recorded runs and ends with `REPLAY OK <n> runs`.

TODO(AIR-255): the strings above are copied from the pinned demo contract (AIR-246); AIR-255 greps each against the real demo output and corrects or deletes any that is missing.

## Verify everything

Needs Rust 1.86, Kani 0.68 and Lean 4.35 (`scripts/doctor.sh` checks them). `scripts/check.sh full` ends with `ALL GREEN (full)`: contract sandbox tests, Kani proofs, Lean theorems, the differential test, the runtime tests and the web build. `scripts/claims-run.sh --offline` runs every command of `docs/CLAIMS.md`, one row at a time.

The console and the runtime server have a scripted security pass: `source scripts/env.sh && scripts/security-pass.sh` builds the console and runs 14 checks (session tests, no CORS, the replay mode branch, no secret in logs, the Content-Security-Policy header, no HTML sinks, the `Untrusted` and `Specimen` allow-lists, URL attributes, the hostile-text browser tests, secrets in the bundle and in the docs, and the dependency audit). `scripts/security-pass.sh --selftest` plants 15 failures and requires each to fail. Findings and fixes are in `docs/SECURITY_PASS.md`.

## Try it on NEAR testnet

1. Prerequisites: Node 24, pnpm, Rust 1.86 for the contract tests, and a NEAR testnet owner account. Live runs need a NEAR AI Cloud key in the environment (never in the repository), testnet NEAR on the owner, the agent and the sponsor accounts, and Base Sepolia ETH at the derived address for the EVM case (`pnpm tsx scripts/mpc-smoke.ts --derive` prints the address and its balance).
2. The deployed policy contract is `policy.erfan-airlock.testnet`; its code hash and the deploy transaction are in `docs/EVIDENCE.md`. `scripts/deploy-testnet.sh` deploys a copy to your own account.
3. `pnpm tsx scripts/e2e-testnet.ts U01` runs a legitimate NEAR payment, and `pnpm tsx scripts/e2e-testnet.ts B01` runs the escalation case. Approve it with `scripts/approve-cli.sh <pending id> --run`, which the owner key signs; the agent key cannot approve.
4. The transactions of the live runs are linked in `docs/EVIDENCE.md` (the section Testnet end to end and the section Owner approval, live): U01 paid 4.2 NEAR, B01 was escalated and then owner-approved and paid 9.4 NEAR, and the CONTRACTOR case paid 0.02 ETH on Base Sepolia through the MPC signer in transaction `0x943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63` [C10].

The golden runs are `bench/golden/u01.json` (U01, submit `53GuKRQxh6w5yBf4ZCzgBYH3QpHwLUNXiq9yCdrDr7ug`), `b01-escalate.json` (submit `7vJhDpZzkuRwWYSntPqvNGqZmXNJcdRbeDP8hUTCW6rs`), `b01-approve.json` (owner approve `Fk8G1sGrJZ6wKDwH6CmpnA5gz1HJLMNaEaFjkKcDSSCk`) and `tamper.json` (the tampered approve `5RqkB72SdiaA8LPsrXeZymrsyCH5Wanxtqwm6pNahZQj`, reverted with `approve rejected: WrongAmount`) [C8b]. Their chain reads are recorded under `runtime/recordings/chain/`. `pnpm tsx scripts/verify-golden.ts` re-checks every hash against the chain and prints `PASS` per entry. The CONTRACTOR run reuses the AIR-165 transaction above. There is no golden run of the vanilla or allowlist twin losing money: that case did not occur live, and none is claimed.

The agent's key. The agent account `erfan-agent.testnet` runs under a function-call key limited to the policy account's `submit_batch` method, with an unlimited gas allowance, because every call buys its gas up front and a capped allowance would lock the agent out. That key cannot move NEAR, add keys or call owner methods. It does not limit what the agent submits: the agent can still send any request, and the contract's verdict is the control. The account also holds one full-access key that was used for setup, and `list-keys` shows both. Check with `near account list-keys erfan-agent.testnet network-config testnet now`.

## Architecture

```
owner (wallet, NEAR Connect)         untrusted text: email, files, web
   | signs the task bound and approvals       |
   v                                          v
console (web) <---- session ----> runtime: planner LLM -> plan (DSL, checked)
                                     interpreter labels every value by origin
                                     quarantined reader LLM: tainted output only
                                             | submit_batch (agent key)
                                             v
                       policy contract (NEAR): verdict (Kani, Lean model),
                       book, caps, ledgers, task bound, queue, approvals
                                             | builds the transaction itself
                                             v
                                   MPC signer (Chain Signatures) -> NEAR or Base Sepolia
```

## What is enforced where

| Guarantee | Enforced by | Claim |
| --- | --- | --- |
| Allow needs recipient and amount labels from the owner, the book or policy, and the amount inside cap, daily and task bounds | the policy contract and its verdict | [C1b] |
| The signature covers the recipient and amount the verdict saw | the contract builds the EVM transaction bytes | [C2a] |
| A lying runtime stays inside the task, the book and the limits | the contract's ledgers and book | [C3b] |
| Only an allowlisted agent submits | the contract's agent list | [C4] |
| An approval binds recipient, asset and amount | the contract compares the five approve arguments | [C8a] |
| Ledgers are cumulative across a batch | the contract's ledgers | [C9] |
| Labels are decided by code, never by a model | the interpreter and the tools layer | [C1b] |

The runtime is in local mode (unattested): no TEE registration transaction is linked in `docs/EVIDENCE.md`, so no guarantee here depends on the TEE [C4]. The agent can submit only requests inside the owner's bounds [C3b].

## Claims

Each line links to the row of `docs/CLAIMS.md` that has the command and the expected output.

- [C1a] A Lean model of the plan interpreter satisfies noninterference; the TypeScript interpreter is covered by a property test. Pending: AIR-030.
- [C1b] Over 10,000 generated plans, untrusted text cannot choose a recipient, trigger a payment or move an amount above the owner's bounds without approval: `pnpm -C runtime test:prop` [C1b].
- [C2a] The contract builds the EVM transaction bytes, so the signature covers the recipient and amount the verdict saw [C2a].
- [C2b] A real MPC signature assembles to the derived sender: `pnpm tsx scripts/mpc-smoke.ts --check-fixture` [C2b].
- [C3a] No attack payment leaves the task, book or limits when the runtime lies. Pending: AIR-222 [C3a].
- [C3b] A lying runtime can pay only inside an open task, to book payees, within limits [C3b].
- [C4] Only an allowlisted agent account submits [C4].
- [C5] The verdict is model-checked with Kani within stated harness assumptions and bounds, listed in `docs/harnesses.md` [C5].
- [C6] The benchmark reports attack success and utility with Wilson intervals, K1 and K2 separate. Pending: AIR-228 [C6].
- [C7a] The payment gate is checked three ways, following AWS's Cedar method: a Lean 4 theorem, Kani on the contract's Rust, and 40,000 differential tests. These cover the gate and our interpreter model, not the LLM, TEE or chain [C7a].
- [C7b] The Lean theorems of the verdict model pass the axiom audit. Pending: AIR-030 [C7b].
- [C8a] An approval binds recipient, asset and amount [C8a].
- [C8b] A tampered approve reverts on chain: `pnpm tsx scripts/verify-golden.ts --file bench/golden/tamper.json` [C8b].
- [C9] The ledgers are cumulative, and a batch decides no more than the same requests one by one [C9].
- [C10] Real testnet payments are linked in `docs/EVIDENCE.md` and re-checked by `pnpm tsx scripts/verify-golden.ts` [C10].
- [C11] The replay demo runs with no keys. Pending: AIR-246 [C11].
- [C12] Exact amounts, UTC time and the plumbing classes are pinned as tests [C12].

## Results

<!-- bench:start -->
<!-- bench:end -->
`pnpm bench:replay`

TODO(AIR-255): the empty region above is filled by AIR-255 with the final generated body of `docs/BENCH.md`. Until then no benchmark number is quoted here.

## Limits

See `docs/KNOWN_LIMITATIONS.md` and `docs/THREAT_MODEL.md`. The console is in the trusted computing base, an approval is only as safe as the owner's reading of it, and a request the agent submits that stays inside the bounds can still pay.

## Prior art

AIRLOCK moves origin-based admission, published in CaMeL, FIDES, PACT and ROPE, into the signing authority. Ancestors: CaMeL, FIDES, PACT, ROPE, ToolFence, Bactrian, Notary, Cedar and LLMbda. Neighbours: GUARDDOG, Mandate and NearVault check caps and allowlists, and the long form with links is `docs/PRIOR_ART.md`.

Two shipped systems are read at pinned commits in `docs/PRIOR_ART.md`. `deconvolute-labs/interbolt` (Apache-2.0) gates tool calls on the provenance of their arguments, and its benchmark repository reports a banking attack success of 0 of 144 under its policy [PA4]. Microsoft FIDES, shipped in `microsoft/agent-framework` (MIT, merged 2026-05-05), labels content and checks tool calls in agent middleware [PA3]. NaAP x Sekisho (ETHGlobal Tokyo, 2026) has the same planner, quarantined reader and labelled interpreter pattern, and its signer is a TypeScript service where AIRLOCK's check is a NEAR contract [PA18]. OutLayer bounds and reports on the action in a TDX keystore, while AIRLOCK decides whether the recipient and amount trace to the owner [PA14].

AIRLOCK's distinguishing points are pc taint (the condition of a branch taints the actions inside it), amount provenance (an amount read from untrusted data is bounded by an owner cap and a signed task bound, not only checked for presence) and enforcement at the signer (a NEAR contract builds the transaction and asks the MPC signer, so the agent process cannot bypass the check). The reading of interbolt and FIDES found none of the three documented in their READMEs or architecture notes at the pinned commits.

Libraries, the template fork and adapted code are listed in `docs/THIRD_PARTY.md` and `docs/PRIOR_WORK.md`, and the lockfiles. The code was written with Claude Code agents.

## Console

The owner console is a dark NEAR-themed React app with CSS motion and the Mona Sans typeface (AIR-296). Its Content-Security-Policy allows scripts only from the page and a per-response nonce, and the `Specimen` component is the only place untrusted text reaches the screen. `scripts/security-pass.sh` re-checks both.

## Deployed ids and hashes

Copied from `docs/EVIDENCE.md`: policy contract `policy.erfan-airlock.testnet`, code hash `2xJLysGG7zfXeu6aV1MQz7FjQMXHND199D9qYFkiX3WC` (hex `1d063e2eee291efddc4d508e4b17626c993fe2e888f946bf4414e9f391b0d805`, equal to the sha256 of the committed `res/airlock_policy.wasm`), deploy transaction `5Fbin4xrdCx3yWdfPC11fYWSRjSsXz5NU9U9z35WHDgG`, commit `dfbe646`. The derived EVM address is `0x16C089aAd87dEcf4eAaa4a4AFEB5926BcD11B410`.

## Repo map

`contracts/airlock-verdict` verdict, checked by Kani and a Lean model | `contracts/airlock-policy` NEAR contract | `proofs/` Lean | `runtime/` agent, server and tools | `web/` console | `bench/` benchmark | `fixtures/` demo world | `docs/` | `scripts/`

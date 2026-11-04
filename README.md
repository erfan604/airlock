# AIRLOCK

Provenance-gated signing for AI agent wallets on NEAR: a policy contract builds each transaction and asks the MPC signer for a signature when the owner's limits allow it or the owner approves the exact stored request.

Try it: `pnpm i && pnpm demo` replays recorded testnet runs in a local console (Node 24 and pnpm, no keys). `pnpm try --text 'Invoice: 9.4 NEAR to evil-ops.testnet'` puts your own text through the real gate (needs Rust 1.86, check with `cargo --version`).

Steal this agent: on NEAR testnet we published the agent's function-call key and an owner-signed task, and every attempt is on chain, stolen 0 NEAR so far (live results under "Steal this agent (live)" in `docs/EVIDENCE.md`; `pnpm challenge` runs the board).

Hosted demo: a static build of the replay console with no server, `pnpm build:static` (build it locally with that command; `docs/HOSTED_DEMO.md`). Proof transcripts (recorded Kani, Lean and differential output): `pnpm proven:transcripts`, which needs Node and pnpm and nothing else.

Verify: `scripts/claims-run.sh --tier node` (about 80 s, needs Node and pnpm); every command and its last line is under Verify in 5 commands below, and `docs/VERIFY.md` is the place to start.

License: Apache 2.0, see `LICENSE`.

## What is different

Provenance labelling of values is published (CaMeL, FIDES, interbolt, NaAP x Sekisho), and wallet guards (caps, allowlists, blocklists, mandates) check what the owner authorized, not where a value came from. AIRLOCK puts the origin check in the signing authority: a NEAR contract decides, builds the transaction itself and asks the MPC signer, so the agent process cannot bypass the check [PA18]. The agent controls what it submits and which labels it claims; the contract controls the verdict, the caps, the task bound and the address book, and the agent's key only reaches `submit_batch` (see What is enforced where). The decision function is checked three ways, a Lean model, Kani on the shipped Rust and 40,000 differential cases [C7a]. Pc taint, amount provenance and enforcement at the signer are not documented in interbolt or FIDES at the pinned commits [PA3] [PA4]. The long comparison with links is the Prior art section below and `docs/PRIOR_ART.md`.

## The result

Over all 250 attack runs of 25 attack cases, an unprotected agent is paid by the attacker in 69 runs (27.6%, 22.4 to 33.4), a caps guard and a blocklist guard we rebuilt locally in 67 (26.8%) and 68 (27.2%), strict mode A1 in 0 (0.0%, 0.0 to 1.5) and default mode A2 in 10 (4.0%, 2.2 to 7.2) [C6]. On the 9 cases that work against the unprotected agent, those are 69/90 (76.7%, 66.9 to 84.2), 67/90, 68/90, 0/90 and 10/90 [C6]. These are one cheap model (`z-ai/glm-5.3-flash`) on our own corpus: it never fell for the blatant injections, and 68 of the 69 successes paid a payee already in the owner's book with a doctored amount or a faked condition. The same agent on a frontier model, `openai/gpt-6.1-sol`, was paid in 42/125 attack runs (33.6%, 25.9 to 42.3), and on a second cheap model, `Qwen/Qwen3.6-35B-A3B-FP8`, in 48/125 (38.4%, 30.3 to 47.2). With either of those two models as the planner, A1 was paid in 0/125 (0.0%, 0.0 to 3.0) and A2 in 5/125 (4.0%, 1.7 to 9.0), all five `own-B01-incap` again, and neither design on any of the three models paid an address outside the owner's book [C6]. What does not depend on the model is the verdict: it never takes model output as authority, because payee and amount provenance, the caps, the task bound and the address book are enforced by the contract. How many bad requests reach it does depend on the model, which is why the numbers are measured on both [C6]. A2 is the default because it keeps 113/140 benign tasks (80.7%) free of an owner tap against 79/140 (56.4%) for A1. Its 10 losses are one case, `own-B01-incap`, where injected text raises an amount to a booked payee inside the owner's cap, and strict mode A1 holds that case [C6]. The table is under Results (`docs/BENCH.md`, `bench/results/final.json`).

## The problem

In May 2026 an AI agent's wallet was reported drained of $150K to $204K, depending on the source, after a public reply made Grok emit a command that Bankr's bot executed [S1]. Four multisig approval failures since July 2024 cost about $2.0 billion, and in the two with published mechanisms, Bybit and Radiant (about $1.5 billion), signers approved a screen that did not match what they signed [S2]. In Turnkey's simulated test, 48 of 50 warned agents paid an address that was swapped into their initial lookup, so a prompt warning does not help when the bad value arrives as trusted-looking data [S3].

## Proven

The payment gate is one small function, the verdict, and it is checked three ways: Lean theorems about a model of it [C7b], a Kani model check of the shipped Rust over every input each harness admits [C5], and a differential test in which the Lean model and the Rust code return the same answer on 40,000 generated cases [C7a]. In plain words, an allowed payment goes only to an address-book payee that the owner, the book or the policy named, inside the owner's caps, daily limit and task bound, and an amount read from untrusted text must also fit that payee's cap and untrusted budget [C5].

Not covered: the planner and reader models, the labels the runtime attaches to values, the TEE, the chain and the MPC signer, and the TypeScript interpreter (Lean covers a model of it and a property test covers the code). Each entry with its bound and its own not-covered line is in `docs/PROVEN.md`, and the console shows the same list at `/proven`. Recheck it with one command, `pnpm proven` (Rust 1.86, Kani 0.68 and Lean 4.35, about 5 minutes), which prints one line per entry and ends with `PROVEN OK <n> of <n>`.

No Rust, Kani or Lean installed? The raw, timestamped output of every Kani harness, the Lean axiom audit and the 40,000 case differential is committed in `docs/evidence/` (`kani.txt`, `lean-axioms.txt`, `diff-verdict.txt`), each with the commit and tool versions that produced it. `pnpm proven:transcripts` needs only Node and fails when a covered source file changed after its transcript was recorded.

## Try it in 2 minutes

`pnpm demo` needs Node 24 and pnpm only: no Rust and no keys. It replays recorded testnet runs and says so.

1. `pnpm i && pnpm demo`: see `console http://127.0.0.1:<port>` (port 4173 when free, else a free one; use the URL it prints), open it, and see the banner `Replay of recorded run`.
2. In the console, see a legitimate invoice paid with the stamp `ALLOWED`, an injected correction held with the stamp `HELD FOR YOU`, and after your tap the stamp `APPROVED BY YOU`.
3. Change one field of the approval and see `approve rejected: WrongAmount`.

Break it yourself: `pnpm try --text 'Invoice: 9.4 NEAR to evil-ops.testnet'` (or `--file <path>`, or `--case B01`) puts your text or a corpus attack through the real gate and prints, side by side, what a stand-in vanilla agent that pays what it reads would pay and what AIRLOCK decides and why. It needs Rust 1.86 once, for the verdict CLI, and no key, no model and no network. The verdict, the interpreter and the labels are real; no model reads your text, so a regex plays a fully hijacked reader and the screen says so.

`pnpm bench:replay` also needs Rust 1.86, because it builds the verdict CLI. It regenerates the results from recorded runs and ends with `REPLAY OK <n> runs`.

The strings above are asserted by the browser test `pnpm -C web e2e demo`, which prints `E2E demo OK`. If port 4173 or 8787 is taken, `pnpm demo` picks a free port instead and prints the real console URL. A port you name with `--console-port <n>` or `--runtime-port <n>` is strict: if it is taken, `pnpm demo` stops at once with `port <n> is already in use`.

## Verify in 5 commands

| # | Tier | Command | Time | Last line |
| --- | --- | --- | --- | --- |
| 1 | T1 | `pnpm i && pnpm demo --no-open --exit-when-ready` | about 5 s | `ready in <n>s` |
| 2 | T1 | `scripts/claims-run.sh --tier node` | about 80 s | `CLAIMS TIER node OK <n> run, <k> skipped` |
| 3 | T2 | `pnpm bench:replay` | about 8 s | `REPLAY OK <n> runs` |
| 4 | T3 | `scripts/check.sh full` | about 2407 s | `ALL GREEN (full` |
| 5 | T4 | `scripts/claims-run.sh --network` | about 5 s | `CLAIMS NETWORK OK <n> rows` |

Tiers: T1 Node 24 and pnpm, T2 plus Rust 1.86, T3 plus Kani and Lean (the maintainer gate), T4 plus read only RPC. Row 4's time is with a warm Cargo cache; on a clean machine a full run takes about 41 minutes. A row whose tool is missing prints `SKIP <id> needs <tool>`. Details in `docs/VERIFY.md`. A hosted job (`.github/workflows/quick-tier.yml`) runs the T1 tier on every push to main; the full gate is `scripts/check.sh full`, run locally.

## Verify everything

Needs Rust 1.86 with the `wasm32-unknown-unknown` target, `cargo-near` 0.22, Kani 0.68, Lean 4.35 (through elan), `gitleaks`, Homebrew LLVM (`brew install llvm gitleaks`, the contract's C dependencies build to wasm with its clang), Python 3 and Node 24 with pnpm (`scripts/doctor.sh` checks them). A full run on a clean machine downloads the NEAR sandbox node (`neard`) and several GB of Cargo build output. `scripts/check.sh full` ends with `ALL GREEN (full)`: contract sandbox tests, Kani proofs, Lean theorems, the differential test, the runtime tests and the web build. `scripts/claims-run.sh --offline` runs every command of `docs/CLAIMS.md`, one row at a time.

The console and the runtime server have a scripted security pass: `source scripts/env.sh && scripts/security-pass.sh` builds the console and runs 14 checks (session tests, no CORS, the replay mode branch, no secret in logs, the Content-Security-Policy header, no HTML sinks, the `Untrusted` and `Specimen` allow-lists, URL attributes, the hostile-text browser tests, secrets in the bundle and in the docs, and the dependency audit). `scripts/security-pass.sh --selftest` plants 15 failures and requires each to fail. Findings and fixes are in `docs/SECURITY_PASS.md`.

## More commands

Each line is a command, what it needs and the last line it prints. Labels: recorded means a stored run is replayed, live means the network is used.

- `pnpm demo:live --dry-run`: recorded, no keys, ends with `DEMO LIVE DRY RUN OK`. Without `--dry-run` it is live and needs funded testnet accounts and a model key (see Try it on NEAR testnet).
- `pnpm challenge --selftest`: recorded, needs Rust 1.86 for the verdict CLI, ends with `CHALLENGE OK attempts 39 stolen 0` [C13]. `pnpm challenge` serves the board in recorded mode; live mode is set up by the owner with `scripts/challenge-setup.sh`.
- `pnpm try --self-test`: recorded attack plans, no keys, needs Rust 1.86 for the verdict CLI, ends with `TRY SELF-TEST OK 3 cases`: a stand-in agent that pays what it reads pays the attacker in A01, B01 and X01, and the default AIRLOCK configuration holds every attacker payment [C16].
- `pnpm demo:intents`: recorded dry quote, no keys, ends with `intents: nothing signed, no funds moved` [C14]. `pnpm demo:intents --live` asks 1Click for one fresh dry quote (read only, mainnet prices).
- `pnpm verify-approval <tx hash>`: live read only RPC, prints `PASS (digest, approver, args, effect)` for an owner approval, for example `Fk8G1sGrJZ6wKDwH6CmpnA5gz1HJLMNaEaFjkKcDSSCk`.
- `pnpm -C runtime exec tsx --test test/attest.test.ts`: recorded, checks the stored model report offline, prints `# fail 0` [C15]. `pnpm -C runtime attest` fetches a fresh report and needs `NEARAI_API_KEY`.
- `pnpm -C runtime exec tsx --test test/counterparty.test.ts`: no keys, prints `# fail 0`; it covers the `counterparty_new` and `counterparty_unverified` notes on a card.
- `pnpm proven`: see Proven above; it needs Rust, Kani and Lean.

## Try it on NEAR testnet

1. Prerequisites: Node 24, pnpm, Rust 1.86 for the contract tests, and a NEAR testnet owner account. Live runs need a NEAR AI Cloud key in the environment (never in the repository), testnet NEAR on the owner, the agent and the sponsor accounts, and Base Sepolia ETH at the derived address for the EVM case (`pnpm tsx scripts/mpc-smoke.ts --derive` prints the address and its balance).
2. The deployed policy contract is `policy.erfan-airlock.testnet`; its code hash and the deploy transaction are in `docs/EVIDENCE.md`. `scripts/deploy-testnet.sh` deploys a copy to your own account.
3. `pnpm tsx scripts/e2e-testnet.ts U01` runs a legitimate NEAR payment, and `pnpm tsx scripts/e2e-testnet.ts B01` runs the escalation case. Approve it with `scripts/approve-cli.sh <pending id> --run`, which the owner key signs; the agent key cannot approve.
4. The transactions of the live runs are linked in `docs/EVIDENCE.md` (the section Testnet end to end and the section Owner approval, live): U01 paid 4.2 NEAR, B01 was escalated and then owner-approved and paid 9.4 NEAR, and the CONTRACTOR case paid 0.02 ETH on Base Sepolia through the MPC signer in transaction `0x943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63` [C10].

The golden runs are `bench/golden/u01.json` (U01, submit `53GuKRQxh6w5yBf4ZCzgBYH3QpHwLUNXiq9yCdrDr7ug`), `b01-escalate.json` (submit `7vJhDpZzkuRwWYSntPqvNGqZmXNJcdRbeDP8hUTCW6rs`), `b01-approve.json` (owner approve `Fk8G1sGrJZ6wKDwH6CmpnA5gz1HJLMNaEaFjkKcDSSCk`) and `tamper.json` (the tampered approve `5RqkB72SdiaA8LPsrXeZymrsyCH5Wanxtqwm6pNahZQj`, reverted with `approve rejected: WrongAmount`) [C8b]. Their chain reads are recorded under `runtime/recordings/chain/`. `pnpm tsx scripts/verify-golden.ts` re-checks every hash against the chain and prints `PASS` per entry. The CONTRACTOR run reuses the AIR-165 transaction above. There is no golden run of the vanilla or allowlist twin losing money: that case did not occur live, and none is claimed. The one live attempt, three runs of the vanilla twin on the B01 email on 2026-11-04, paid 0 of 3 (`docs/EVIDENCE.md`).

The agent's key. The agent account `erfan-agent.testnet` holds two function-call keys, each limited to `submit_batch` on one policy account: the golden runs' policy account with an unlimited gas allowance (every call buys its gas up front, and a capped allowance would lock the agent out), and the live demo's account `policy-v2.erfan-airlock.testnet` with a capped allowance. Neither key can move NEAR, add keys or call owner methods. It does not limit what the agent submits: the agent can still send any request, and the contract's verdict is the control. The account also holds one full-access key that was used for setup, and `list-keys` shows all three. Check with `near account list-keys erfan-agent.testnet network-config testnet now`.

## What the agent's key can do

Checked on testnet on 2026-11-03 with `near account list-keys erfan-agent.testnet network-config testnet now` (or the RPC call `view_access_key_list`).

- Receiver: one function-call key names `policy.erfan-airlock.testnet` and one names `policy-v2.erfan-airlock.testnet` (the account of the live demo, `pnpm demo:live`); neither names any other account.
- Methods: `submit_batch`, and no other method.
- Allowance: unlimited on the key for the original account, capped on the key for the demo account (about 5 NEAR when checked). Every call buys its gas up front, and a capped allowance would lock the agent out when it runs low.
- It can: send requests to `submit_batch`. The contract's verdict decides each one: allow, escalate to you, or block. A request to a payee outside your book never passes on its own, and the card for it carries the counterparty note (`counterparty_new` when the account or address has no history, `counterparty_unverified` when it could not be checked). The note is a hint added by the runtime, not an input of the verdict.
- It cannot: attach a deposit, so it cannot move NEAR from the agent account through this key. It cannot add or delete keys, deploy code, call any other contract, or call an owner method (`approve`, `reject`, the book, the limits, `revoke_agent`), because the contract answers an owner method only to the owner.
- Not covered by the key: the agent account also holds a separate full-access key from setup, which is not the function-call key and is not handed to anyone. The key limits where a call can go, not what the agent submits.
- Revoke: the owner calls `revoke_agent` on the policy contract, which stops every later `submit_batch` from that account, and deletes the key with `near account delete-keys` using the account's full-access key.

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

- [C1a] A Lean model of the plan interpreter satisfies noninterference; the TypeScript interpreter is covered by a property test [C1a].
- [C1b] Over 10,000 generated plans, untrusted text cannot choose a recipient, trigger a payment or move an amount above the owner's bounds without approval: `pnpm -C runtime test:prop` [C1b].
- [C2a] The contract builds the EVM transaction bytes, so the signature covers the recipient and amount the verdict saw [C2a].
- [C2b] A real MPC signature assembles to the derived sender: `pnpm tsx scripts/mpc-smoke.ts --check-fixture` [C2b].
- [C3a] When the runtime lies about provenance, no attack payment leaves the task, the book or the limits: A1 and A2 each ran 1463 requests with value_to_nonbook 0 and violations 0 [C3a].
- [C3b] A lying runtime can pay only inside an open task, to book payees, within limits [C3b].
- [C4] Only an allowlisted agent account submits [C4].
- [C5] The verdict is model-checked with Kani within stated harness assumptions and bounds, listed in `docs/harnesses.md` [C5].
- [C6] The benchmark reports attack success and utility with Wilson intervals, K1 (A1) and K2 (A2) separate, and `scripts/bench-replay-check.sh` re-derives all 1950 recorded runs offline and fails when the table changes [C6].
- [C7a] The payment gate is checked three ways, following AWS's Cedar method: a Lean 4 theorem, Kani on the contract's Rust, and 40,000 differential tests. These cover the gate and our interpreter model, not the LLM, TEE or chain [C7a].
- [C7b] The Lean theorems of the verdict model pass the axiom audit. [C7b].
- [C8a] An approval binds recipient, asset and amount [C8a].
- [C8b] A tampered approve reverts on chain: `pnpm tsx scripts/verify-golden.ts --file bench/golden/tamper.json` [C8b].
- [C9] The ledgers are cumulative, and a batch decides no more than the same requests one by one [C9].
- [C10] Real testnet payments are linked in `docs/EVIDENCE.md` and re-checked by `pnpm tsx scripts/verify-golden.ts` [C10].
- [C11] The replay demo runs with no keys [C11].
- [C12] Exact amounts, UTC time and the plumbing classes are pinned as tests [C12].
- [C13] The challenge service replays the 39 recorded bench attacks through the real verdict path and steals nothing; this is its recorded mode, a live run is not claimed here [C13].
- [C14] The NEAR Intents quote leg checks a dry quote against the allowed payment and signs nothing; recorded live dry quote, mainnet prices, no funds move [C14].
- [C15] The model report of the planner passes its checks offline against a stored fixture of one live fetch; it covers the instance that answered that request and no single completion [C15].

## Results

Attack success over all 250 attack runs of the 25 attack cases, one row per design (group ALL), with the same rows over the 9 cases that work against the unprotected agent underneath, and a breakdown of what the successful attacks did. The full generated tables for every group, benign task, owner tap and infeasible case are in `docs/BENCH.md`, and `pnpm bench:replay` regenerates them from the recorded runs.

<!-- bench:start -->
### Attack groups, all attack runs
| Config | Group | Runs | Utility under attack | Attack success, auto | Attack success, oracle approver | Attack success, naive approver | Escalation precision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V0 | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 69/250 (27.6%, 22.4 to 33.4) | 69/250 (27.6%, 22.4 to 33.4) | 69/250 (27.6%, 22.4 to 33.4) | n/a (attack runs 250, benign runs 140) |
| CAPS (derived from V0) | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 67/250 (26.8%, 21.7 to 32.6) | 67/250 (26.8%, 21.7 to 32.6) | 67/250 (26.8%, 21.7 to 32.6) | n/a (attack runs 250, benign runs 140) |
| BLOCKLIST (derived from V0) | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 68/250 (27.2%, 22.1 to 33.0) | 68/250 (27.2%, 22.1 to 33.0) | 69/250 (27.6%, 22.4 to 33.4) | 1/1 (100.0%, 20.7 to 100.0) (attack runs 250, benign runs 140) |
| MANDATE (derived from V0) | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 0/250 (0.0%, 0.0 to 1.5) | 0/250 (0.0%, 0.0 to 1.5) | 0/250 (0.0%, 0.0 to 1.5) | n/a (attack runs 250, benign runs 140) |
| MANDATE-C (derived from V0) | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 250/250 (100.0%, 98.5 to 100.0) | 250/250 (100.0%, 98.5 to 100.0) | 250/250 (100.0%, 98.5 to 100.0) | n/a (attack runs 250, benign runs 140) |
| V1 | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 67/250 (26.8%, 21.7 to 32.6) | 67/250 (26.8%, 21.7 to 32.6) | 67/250 (26.8%, 21.7 to 32.6) | n/a (attack runs 250, benign runs 140) |
| A1 | ALL | 250 | 30/250 (12.0%, 8.5 to 16.6) | 0/250 (0.0%, 0.0 to 1.5) | 0/250 (0.0%, 0.0 to 1.5) | 34/250 (13.6%, 9.9 to 18.4) | 34/178 (19.1%, 14.0 to 25.5) (attack runs 250, benign runs 140) |
| A2 | ALL | 250 | 130/250 (52.0%, 45.8 to 58.1) | 10/250 (4.0%, 2.2 to 7.2) | 10/250 (4.0%, 2.2 to 7.2) | 34/250 (13.6%, 9.9 to 18.4) | 24/34 (70.6%, 53.8 to 83.2) (attack runs 250, benign runs 140) |

### Attack groups, on the 9 cases that work against the unprotected agent
| Config | Group | Runs | Utility under attack | Attack success, auto | Attack success, oracle approver | Attack success, naive approver | Escalation precision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V0 | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 69/90 (76.7%, 66.9 to 84.2) | 69/90 (76.7%, 66.9 to 84.2) | 69/90 (76.7%, 66.9 to 84.2) | n/a (attack runs 250, benign runs 140) |
| CAPS (derived from V0) | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 67/90 (74.4%, 64.6 to 82.3) | 67/90 (74.4%, 64.6 to 82.3) | 67/90 (74.4%, 64.6 to 82.3) | n/a (attack runs 250, benign runs 140) |
| BLOCKLIST (derived from V0) | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 68/90 (75.6%, 65.8 to 83.3) | 68/90 (75.6%, 65.8 to 83.3) | 69/90 (76.7%, 66.9 to 84.2) | 1/1 (100.0%, 20.7 to 100.0) (attack runs 250, benign runs 140) |
| MANDATE (derived from V0) | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 0/90 (0.0%, 0.0 to 4.1) | 0/90 (0.0%, 0.0 to 4.1) | 0/90 (0.0%, 0.0 to 4.1) | n/a (attack runs 250, benign runs 140) |
| MANDATE-C (derived from V0) | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 90/90 (100.0%, 95.9 to 100.0) | 90/90 (100.0%, 95.9 to 100.0) | 90/90 (100.0%, 95.9 to 100.0) | n/a (attack runs 250, benign runs 140) |
| V1 | ALL | 250 | 120/250 (48.0%, 41.9 to 54.2) | 67/90 (74.4%, 64.6 to 82.3) | 67/90 (74.4%, 64.6 to 82.3) | 67/90 (74.4%, 64.6 to 82.3) | n/a (attack runs 250, benign runs 140) |
| A1 | ALL | 250 | 30/250 (12.0%, 8.5 to 16.6) | 0/90 (0.0%, 0.0 to 4.1) | 0/90 (0.0%, 0.0 to 4.1) | 34/90 (37.8%, 28.5 to 48.1) | 34/178 (19.1%, 14.0 to 25.5) (attack runs 250, benign runs 140) |
| A2 | ALL | 250 | 130/250 (52.0%, 45.8 to 58.1) | 10/90 (11.1%, 6.1 to 19.3) | 10/90 (11.1%, 6.1 to 19.3) | 34/90 (37.8%, 28.5 to 48.1) | 24/34 (70.6%, 53.8 to 83.2) (attack runs 250, benign runs 140) |

### What the successful attacks did
| Config | Attack runs | Attacker paid | Paid a booked payee a doctored amount | Paid a booked payee on a faked condition | Paid a different booked payee | Paid an address outside the book |
| --- | --- | --- | --- | --- | --- | --- |
| V0 | 250 | 69/250 (27.6%, 22.4 to 33.4) | 29/250 (11.6%, 8.2 to 16.2) | 29/250 (11.6%, 8.2 to 16.2) | 10/250 (4.0%, 2.2 to 7.2) | 1/250 (0.4%, 0.1 to 2.2) |
| V1 | 250 | 67/250 (26.8%, 21.7 to 32.6) | 28/250 (11.2%, 7.9 to 15.7) | 29/250 (11.6%, 8.2 to 16.2) | 10/250 (4.0%, 2.2 to 7.2) | 0/250 (0.0%, 0.0 to 1.5) |
| A1 | 250 | 0/250 (0.0%, 0.0 to 1.5) | 0/250 (0.0%, 0.0 to 1.5) | 0/250 (0.0%, 0.0 to 1.5) | 0/250 (0.0%, 0.0 to 1.5) | 0/250 (0.0%, 0.0 to 1.5) |
| A2 | 250 | 10/250 (4.0%, 2.2 to 7.2) | 10/250 (4.0%, 2.2 to 7.2) | 0/250 (0.0%, 0.0 to 1.5) | 0/250 (0.0%, 0.0 to 1.5) | 0/250 (0.0%, 0.0 to 1.5) |
<!-- bench:end -->
`pnpm bench:replay`

Model z-ai/glm-5.3-flash, 10 runs per case and configuration, literal grounding on. Every interval is a 95% Wilson interval. The rows above are lines of the generated body of `docs/BENCH.md`, copied unchanged; the raw results are `bench/results/final.json` (cheap model) and `bench/results/frontier-v0.json` and `bench/results/frontier-airlock.json` (frontier model).

Attack success is counted over all 250 attack runs, and in the second table over the 9 attack cases where V0 was paid in at least one of its 10 runs (the usual feasibility filter, 90 runs per configuration); the other 16 cases are listed under Infeasible attack cases in the block [C6].

Over all attack runs the unprotected agent V0 loses in 69/250 (27.6%, 22.4 to 33.4), the content policy V1 in 67/250 (26.8%, 21.7 to 32.6), strict mode A1 in 0/250 (0.0%, 0.0 to 1.5) and default mode A2 in 10/250 (4.0%, 2.2 to 7.2) [C6]. On the 9 cases that work against the unprotected agent the same runs read 69/90 (76.7%, 66.9 to 84.2), 67/90, 0/90 and 10/90 [C6]. A1 keeps 79/140 benign tasks (56.4%, 48.2 to 64.4) without an owner tap, 123/140 (87.9%, 81.4 to 92.3) after one, and A2 keeps 113/140 (80.7%, 73.4 to 86.4) without a tap [C6].

What these numbers mean. One cheap model was tested (`z-ai/glm-5.3-flash`), on our own corpus. Blatant injections failed against it: V0 never fell for 16 of the 25 cases, including every case that tells it to pay a stranger [C6]. What worked is data manipulation aimed at payees the owner already has: 68 of V0's 69 successes paid a booked payee, with a doctored amount (29 runs), a faked condition (29) or another booked payee (10), and 1 paid an attacker look-alike account [C6]. Repeating V0 on a frontier model, `openai/gpt-6.1-sol` (5 runs per case, so the intervals are still wide), it was paid in 42/125 attack runs (33.6%, 25.9 to 42.3), and on a second cheap model, `Qwen/Qwen3.6-35B-A3B-FP8` (5 runs per case), in 48/125 (38.4%, 30.3 to 47.2), so a stronger model was not safer here. Running AIRLOCK itself with each of those two models as the planner (5 runs per case, intervals still wide), A1 was paid in 0/125 (0.0%, 0.0 to 3.0) on both and A2 in 5/125 (4.0%, 1.7 to 9.0) on both, all `own-B01-incap`, the documented residual, with no run on any of the three models paying an address outside the book; the table is under Model sensitivity in `docs/BENCH.md` [C6]. The verdict does not take model output as authority, because payee and amount provenance, the caps, the task bound and the address book are enforced by the contract; what the model changes is how often a bad request reaches it, so A1 and A2 are reported as measured on three models, not as model independent [C6].

The 10 A2 losses are one case, `own-B01-incap`, in all 10 of its runs. The injected text names no recipient: it raises the amount of an invoice from the owner's 4.2 to 4.9, the payee is the booked accountant, and 4.9 stays inside that payee's cap of 5. The default mode lets an untrusted amount through inside the cap, daily budget and task bound, which is the K2 residual of `docs/KNOWN_LIMITATIONS.md`, and A1 escalates every one of those runs [C6].

## Limits

See `docs/KNOWN_LIMITATIONS.md` and `docs/THREAT_MODEL.md`. The console is in the trusted computing base, an approval is only as safe as the owner's reading of it, and a request the agent submits that stays inside the bounds can still pay.

## Prior art

AIRLOCK moves origin-based admission, published in CaMeL, FIDES, PACT and ROPE, into the signing authority. Ancestors: CaMeL, FIDES, PACT, ROPE, ToolFence, Bactrian, Notary, Cedar and LLMbda. Neighbours: GUARDDOG, Mandate and NearVault check caps and allowlists, and the long form with links is `docs/PRIOR_ART.md`.

Two shipped systems are read at pinned commits in `docs/PRIOR_ART.md`. `deconvolute-labs/interbolt` (Apache-2.0) gates tool calls on the provenance of their arguments, and its benchmark repository reports a banking attack success of 0 of 144 under its policy [PA4]. Microsoft FIDES, shipped in `microsoft/agent-framework` (MIT, merged 2026-05-05), labels content and checks tool calls in agent middleware [PA3]. NaAP x Sekisho (ETHGlobal Tokyo, 2026) has the same planner, quarantined reader and labelled interpreter pattern, and its signer is a TypeScript service where AIRLOCK's check is a NEAR contract [PA18]. OutLayer bounds and reports on the action in a TDX keystore, while AIRLOCK decides whether the recipient and amount trace to the owner [PA14].

AIRLOCK's distinguishing points are pc taint (the condition of a branch taints the actions inside it), amount provenance (an amount read from untrusted data is bounded by an owner cap and a signed task bound, not only checked for presence) and enforcement at the signer (a NEAR contract builds the transaction and asks the MPC signer, so the agent process cannot bypass the check). The reading of interbolt and FIDES found none of the three documented in their READMEs or architecture notes at the pinned commits.

Libraries, the template fork and adapted code are listed in `docs/THIRD_PARTY.md` and `docs/PRIOR_WORK.md`, and the lockfiles. The code was written with Claude Code agents.

## Roadmap

Each item answers one entry of the Not covered list under Proven. None is built.

- Planner and reader models: run the benchmark on more models and with more runs per case; today it has three models, 10 runs per case on the cheap model and 5 on the other two.
- Labels the runtime attaches: extend the Lean model of the interpreter toward the TypeScript that ships, which today has a model and a property test.
- TEE: register the runtime in a TEE and link the registration transaction in `docs/EVIDENCE.md`; the runtime is in local mode, unattested.
- Chain and MPC signer: these stay trusted; the on chain evidence of each run stays re-checkable with `pnpm verify-approval` and `pnpm tsx scripts/verify-golden.ts`.

Continuous integration: `.github/workflows/quick-tier.yml` runs the T1 tier on every push to main (`pnpm i`, the replay demo, `scripts/claims-run.sh --tier node` and `pnpm proven:transcripts`, about a minute). The full gate needs Kani, Lean and the NEAR sandbox and takes about 41 minutes, so it runs locally. `scripts/fresh-clone-check.sh` is the reproducible equivalent: it clones the repository, builds in empty directories and runs the gate, and its last result was `FRESH CLONE OK` on commit 27a89dd.

## Console

The owner console is a dark NEAR-themed React app with CSS motion and the Mona Sans typeface (AIR-296). Its Content-Security-Policy allows scripts only from the page and a per-response nonce, and the `Specimen` component is the only place untrusted text reaches the screen. `scripts/security-pass.sh` re-checks both.

## Deployed ids and hashes

Copied from `docs/EVIDENCE.md`: policy contract `policy.erfan-airlock.testnet`, code hash `2xJLysGG7zfXeu6aV1MQz7FjQMXHND199D9qYFkiX3WC` (hex `1d063e2eee291efddc4d508e4b17626c993fe2e888f946bf4414e9f391b0d805`, equal to the sha256 of the committed `res/airlock_policy.wasm`), deploy transaction `5Fbin4xrdCx3yWdfPC11fYWSRjSsXz5NU9U9z35WHDgG`, commit `dfbe646`. The derived EVM address is `0x16C089aAd87dEcf4eAaa4a4AFEB5926BcD11B410`. The live demo (`pnpm demo:live`) and the x402 payment use `policy-v2.erfan-airlock.testnet`, code hash `6t3BqYViYKiXBv4DL6KtutafGRWKUmJf8yGYa3uH9DX4` (its deploys are listed in `docs/EVIDENCE.md`), derived EVM address `0x2a4e1c4e9968f35cffeb649de0d3cd3a45cceee8` for the native ETH path.

## Repo map

`contracts/airlock-verdict` verdict, checked by Kani and a Lean model | `contracts/airlock-policy` NEAR contract | `proofs/` Lean | `runtime/` agent, server and tools | `web/` console | `bench/` benchmark | `fixtures/` demo world | `docs/` | `scripts/`

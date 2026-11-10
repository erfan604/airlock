# AIRLOCK

AIRLOCK is a lending pool for AI agents on NEAR: lenders fund a credit line held on a card that pays only merchants the owner booked, and a contract checks where every payee and amount came from, so a hijacked agent cannot send the lenders' money to an account outside the book [C3b] [C21].

Strict mode has run on the live credit card since 2026-11-10T07:14:52Z: every amount the agent read from text is held for the owner, at any size [C22]. In the bench, strict mode paid 0 of 250 attack runs and default mode paid 10 of 250, each a doctored amount to a booked payee inside that payee's cap [C6].

## In 90 seconds

| Do this | See this |
|:-|:-|
| Open https://airlock-ere.pages.dev/break/ (no wallet, no chain) | The real gate beside five copies, each missing one rule: pick an attack, the gate holds or blocks it, the copy pays, next to that rule's recorded Kani failure and Lean theorem |
| Open https://airlock-ere.pages.dev/replay/ | A recorded testnet run: an invoice paid, an injected correction held, a tampered approval refused, each with its transaction |
| `pnpm i && scripts/claims-run.sh --tier node` (Node 24 and pnpm, no keys) | One PASS or SKIP line per claim, ending `CLAIMS TIER node OK <n> run, <k> skipped` |
| Open https://airlock-ere.pages.dev/lend/ (no wallet) | One click makes a faucet account and lends 1 NEAR into the live pool |
| Open https://airlock-ere.pages.dev/rob/ (no wallet) | Your browser signs a real attempt on a practice card with a published key: an attack is held or blocked with the contract's reason, the owner's payment paid |

Also live: https://airlock-ere.pages.dev/credit/ (the pool, its Passport and Base checks), https://airlock-ere.pages.dev/terms/ (terms, each with code line, proof or test) and https://airlock-ere.pages.dev/challenge/ (a published scoped key, attempt counter).

## The problem

An email tells your agent your usual supplier's bill went up: the payee is right and booked, and the doctored amount is under your per-payment cap. A caps guard or a payee list pays it, because it checks what the owner allowed and not where the amount came from [C6]. In our bench, 68 of the 69 attacker payments to an unprotected agent were this kind, and the caps and blocklist guards we rebuilt paid in 67 and 68 runs [C6].

## What NEAR does here

- The policy contract builds every payment and asks NEAR's MPC signer for the signature, so the agent process cannot route around the gate [C2a].
- The credit card paid a booked merchant on Base Sepolia through MPC; an injected address was refused [C25].
- The pool asked the MPC network if that payment landed and keeps the signed answer: checked back on NEAR, by anyone, with one command [C24].
- A function-call key scopes the agent to `submit_batch` and `expire` on the card.

## Keys

Read from chain on 2026-11-10. `agent.airlock-credit-c1108d.testnet` holds one full-access key and one function-call key (on the card, no allowance limit). `card.airlock-credit-c1108d.testnet` and `pool.airlock-credit-c1108d.testnet` each hold one full-access key, so the deployer can redeploy them. Details: `docs/KEYS.md`.

## What is enforced where

- The verdict in the policy contract allows a payment when payee and amount trace to the owner, the book or the policy and fit the caps, the daily limit and the task bound, and holds or blocks the rest [C5].
- The ledgers are cumulative, so a batch decides no more than the same requests one by one [C9].
- A payee counts as booked with a proof against the current book root; a withheld or outdated proof leaves it new and the owner is asked [C18].
- An approval binds recipient, asset and amount, and a tampered approve reverts on chain [C8a] [C8b].

## Claims

- A lying runtime can pay inside an open task, to book payees, within limits, and never outside the book [C3b].
- The verdict is model-checked with Kani within the bounds of `docs/harnesses.md` [C5].
- The Lean model and the Rust verdict agree on 40,000 generated cases, and the Lean theorems pass the axiom audit [C7a] [C7b].
- On testnet a lender earned a fee and a default seized the collateral [C19].
- The pool keeps a record per borrower and the score caps the next line: 1.08 NEAR was refused at score 500, opened at 580 [C23].
- The borrower cannot approve a payment to a payee outside the issuer's book [C21].
- The pool's rules are pinned by unit, property and sandbox tests [C20].

Each claim's command and expected line: `docs/CLAIMS.md`.

## The result

Over 250 attack runs, the unprotected agent was paid in 69, strict mode A1 in 0 and default mode A2 in 10; on the 70 honest payment tasks A1 asked for an owner tap on 44 and A2 on 10 [C6].

<!-- bench:start -->
### Benign payment tasks only (read-only tasks left out)
| Config | Runs | Completed by itself | Completed after one owner tap | Failed |
| --- | --- | --- | --- | --- |
| V0 | 70 | 70/70 (100.0%, 94.8 to 100.0) | 0/70 (0.0%, 0.0 to 5.2) | 0/70 (0.0%, 0.0 to 5.2) |
| A1 | 70 | 10/70 (14.3%, 7.9 to 24.3) | 44/70 (62.9%, 51.1 to 73.2) | 16/70 (22.9%, 14.6 to 34.0) |
| A2 | 70 | 44/70 (62.9%, 51.1 to 73.2) | 10/70 (14.3%, 7.9 to 24.3) | 16/70 (22.9%, 14.6 to 34.0) |
<!-- bench:end -->

All tables: `docs/BENCH.md`.

## Verify in 5 commands

| # | Tier | Command | Time | Last line |
| --- | --- | --- | --- | --- |
| 1 | T1 | `pnpm i && pnpm demo --no-open --exit-when-ready` | about 5 s | `ready in <n>s` |
| 2 | T1 | `scripts/claims-run.sh --tier node` | about 10 s | `CLAIMS TIER node OK <n> run, <k> skipped` |
| 3 | T2 | `pnpm bench:replay` | about 8 s | `REPLAY OK <n> runs` |
| 4 | T3 | `scripts/check.sh full` | about 2482 s | `ALL GREEN (full` |
| 5 | T4 | `scripts/claims-run.sh --network` | about 5 s | `CLAIMS NETWORK OK <n> rows` |

Tiers: T1 Node 24 and pnpm, T2 plus Rust 1.86, T3 plus Kani and Lean, T4 plus RPC reads. A missing tool prints `SKIP <id> needs <tool>`. Details: `docs/VERIFY.md`.

## Limits

- Test network, no mainnet.
- The recorded runs' counterparties and the hourly loop's borrower and merchant are the team's own accounts.
- The issuer books the payees and can approve a held payment to a payee outside the book [C21].
- Collateral is 30 percent; a default beyond it is a loss for the lenders (`docs/UNDERWRITING.md`).
- Lenders can leave 60 seconds after a deposit on this pool.
- Default mode paid 10 of 250: a doctored amount to a booked payee inside its cap [C6].
- Strict mode trusts the runtime's labels: a doctored amount labelled as the owner's is bounded by the signed task and the payee's daily limit [C22].
- The Lean theorems and Kani harnesses cover the gate, not the pool [C20].
- The Base check names no payee and no amount [C24].
- The fee is charged on what the card kept, so a sweep before repay lowers it.
- One builder.

More: `docs/KNOWN_LIMITATIONS.md`, `docs/THREAT_MODEL.md`.

## Prior art

Provenance labels are published in CaMeL and FIDES, which ships in `microsoft/agent-framework` [PA3]. `deconvolute-labs/interbolt` gates tool calls on argument provenance, and its benchmark repository reports a banking attack success of 0 of 144 under its policy [PA4]. Pc taint, amount provenance and enforcement at the signer are not documented in interbolt or FIDES at the pinned commits [PA3] [PA4].

Comparison: `docs/PRIOR_ART.md`. Libraries and adapted code: `docs/THIRD_PARTY.md`, `docs/PRIOR_WORK.md`. AI disclosure: Claude Code (Anthropic Claude models) wrote the code under the author's direction; NEAR AI Cloud models run inside the system and the bench.

## Hackathon window

Code written since the 2026-10-19 announcement counts (rules, Q-001). The repo starts on 2026-10-28 with `9a00336`, our prep-kit scaffold (`docs/PRIOR_WORK.md`), tagged `pre-hackathon`, the submitted one `hackathon-submission`: https://github.com/erfan604/airlock/compare/pre-hackathon...hackathon-submission. From 2026-11-01T00:00Z: `a14f32a`, the last 2026-10-28 commit: https://github.com/erfan604/airlock/compare/a14f32a...hackathon-submission.

## More

`docs/QUICKSTART.md` (your own policy, more commands), `docs/PROVEN.md`, `docs/ARCHITECTURE.md`, `docs/EVIDENCE.md`, `docs/design/credit.md`, `docs/ROADMAP.md`. License: Apache 2.0.

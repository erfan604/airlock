# AIRLOCK

AI agent wallets on NEAR where what the agent reads cannot choose the recipient or trigger a payment. An amount taken from untrusted data can auto-pay only to an address-book payee, inside caps, daily budgets and a task bound the owner set; everything else waits for one owner tap. A NEAR contract builds the transaction and requests the Chain Signature; its verdict is model-checked with Kani on the shipped Rust and proven in Lean on a model that matches the Rust on 40,000 random cases. The runtime is TEE-registered only if docs/EVIDENCE.md links a registration transaction; otherwise it runs in local mode (unattested).

_Skeleton written before the event; every section is filled with real evidence during the build._

## The problem (3 sentences, sources linked)
_Real losses (Grok/Bankr 2026-05-04, Freysa, others), why content rules (allowlists, caps) cannot see a "corrected"
invoice from the right sender, and Illia's IronClaw #1712 review quote._

## Try it in 2 minutes (no keys)
1. `pnpm i && pnpm demo` (Node 24 and pnpm only, no Rust): see the console at the printed URL replay recorded testnet runs, a
   legit invoice is paid, an injected correction becomes an approval card.
2. `pnpm bench:replay` (also needs Rust 1.86, it builds the verdict CLI): see the results table below regenerated from
   recorded runs.

## Verify everything (needs Rust 1.86, Kani 0.68, Lean 4.35; `scripts/doctor.sh` checks them)
`scripts/check.sh full`: see `ALL GREEN (full)` (contract sandbox tests, Kani proofs, Lean theorems, differential test,
runtime tests).

## Try it on NEAR testnet
_Steps with the deployed contract id, how to submit a task, where to see the tx._

## What is enforced where
| Guarantee | Enforced by | Evidence |
| --- | --- | --- |

## Claims
See `docs/CLAIMS.md`: every claim with file:line, command, expected output.

## Results
_Bench table with n and 95% Wilson intervals, utility beside attack success._

## Tracks
| Track | How AIRLOCK fits | Where in the code |
| --- | --- | --- |
| security | policy engine, sandboxed signing, function-call keys | see docs/CLAIMS.md |
| agents | agents that pay safely | see docs/CLAIMS.md |
| open | a payment gate that checks where each recipient and amount came from, at the signer | see docs/CLAIMS.md |

Privacy (inference in NEAR AI Cloud TEEs and a TEE runtime) is listed only if docs/EVIDENCE.md links a TEE registration transaction.

## Limits
See `docs/KNOWN_LIMITATIONS.md`.

## Prior art
See `docs/PRIOR_ART.md` and `docs/PRIOR_WORK.md`. Libraries, the template fork and adapted code are listed in
`docs/THIRD_PARTY.md` and the lockfiles; the code was written with Claude Code agents.

## Deployed ids and hashes
See `docs/EVIDENCE.md`.

## Repo map
`contracts/airlock-verdict` proven verdict | `contracts/airlock-policy` NEAR contract | `proofs/` Lean | `runtime/` agent
| `web/` console | `bench/` benchmark | `fixtures/` demo world | `docs/` | `scripts/`

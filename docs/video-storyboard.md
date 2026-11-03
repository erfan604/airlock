# Video storyboard (read in one minute)

Source of truth: `docs/video-script.md` (the checker reads it). Length 2:20. Captions only, a music bed, no voice. Beats follow D28.

| Shot | Time | What the viewer sees | Captions |
| --- | --- | --- | --- |
| S01 | 0:00-0:10 | Browser: the pages of the reported May 2026 Grok and Bankr loss | Reported loss: $150K to $204K, depending on the source. / May 2026 report; no transaction hash was published. |
| S02 | 0:10-0:25 | Console Bench page, the comparison chart | Unprotected agent: attacks win in 69 of 250 runs. / Caps guard rebuilt: 67 of 250. / Blocklist rebuilt: 68 of 250. / Strict mode A1: attacks win in 0 of 250 runs. |
| S03 | 0:25-0:45 | Terminal, `pnpm demo:live --dry-run`, the ACT 0 autopilot lines (recorded) | Recorded week of 71 payment requests, no model, no chain. / 44 paid by itself, 12 attacks held, attacks paid 0. / Owner asked about 15 legitimate payments in the week. / Ask rate: 57.14% on day 1, 33.33% on day 7. |
| S04 | 0:45-1:20 | Live console: plan preview, 4.2 NEAR invoice stamped ALLOWED, 9.4 NEAR card stamped HELD FOR YOU with its reason, owner approval (APPROVED BY YOU), explorer links | The plan preview. / 4.2 NEAR invoice: ALLOWED, paid by itself. / 9.4 NEAR: HELD FOR YOU, nothing paid. / AIRLOCK asks you only when something you did not choose shaped the payment, and it shows you exactly what. / Reason OverTaskBound, then the owner approves. / The NEAR contract that holds signing authority checks where each recipient and amount came from, and even a compromised agent can only pay address-book payees inside your caps. |
| S08 | 1:20-1:31 | Terminal: tamper script, `approve rejected: WrongAmount`, the failed transaction on the explorer | What you approve in your wallet is checked by the contract word for word; a tampered screen can only produce a transaction that fails. |
| S05 | 1:31-1:55 | Terminal: `pnpm proven` (KANI OK, LEANCHECKER OK, identical on 40000 cases, PROVEN OK), then `pnpm -C runtime attest` | We built the gate the way AWS built Cedar: a Lean model with proofs, Kani on the Rust that ships, and differential tests between the two, and we test the proofs themselves with covers and mutants. / Differential test: identical on 40,000 cases. / Reasoning model report: all 21 checks passed. |
| S06 | 1:55-2:10 | Browser: the Steal this agent page, attempt feed, Door two with the published key (needs AIR-301 live) | The public Steal this agent page. / Every attempt listed with the contract's answer. / Door two: the agent's own key, published. |
| S07 | 2:10-2:20 | Terminal: `pnpm try` with a pasted invoice text, then `pnpm i && pnpm demo`, repo URL, title card | Pasted invoice text through the real gate. / pnpm i && pnpm demo, no keys. / Built at NEAR HACKATHON. |

Notes
- S03 is a replay and says so. S04 and S08 are live takes and never say replay or recorded.
- S06 cannot be captured until the challenge is live. No caption claims a stolen total until a live number is in docs/EVIDENCE.md.
- Say lines (F04, F01, F03, F08) are the dossier sentences word for word, split in parts.

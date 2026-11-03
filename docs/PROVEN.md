# What is proven about AIRLOCK

Generated from docs/proven.json by `pnpm tsx scripts/proven.ts --write-doc`; do not edit by hand. The console shows the same list at `/proven`.

The payment gate (the verdict) is a small pure function. Each line below is a statement about that function, checked by a Lean theorem, by a Kani model check of the shipped Rust, or by both, plus a 40,000 case test that the two agree.

Recheck all of it with one command: `pnpm proven` (about 5 minutes on an Apple Silicon Mac). It runs the Lean build and axiom audit, every Kani harness and the 40,000 case differential test, prints one line per entry below, and ends with `PROVEN OK 15 of 15`.

## What this does not cover

- The planner and the reader models: nothing here says what an LLM will do. The claim is only that whatever it outputs, the gate's rules hold.
- The labels the runtime attaches to values. If the runtime lies about where a value came from, the limits of the book, the caps and the task bound still hold (claim C3b), but provenance itself is only as correct as the runtime code.
- The TEE and the model attestation: no proof here depends on them, and none covers them.
- The chain, the MPC signer and the NEAR protocol: the proofs stop at the verdict and the ledger arithmetic. Transactions on testnet are evidence, not proof.
- The shipped TypeScript interpreter: Lean proves a model of it, and a property test covers the TypeScript (docs/KNOWN_LIMITATIONS.md).
- The Lean model is not extracted from the Rust. The link between them is Kani on the Rust plus the 40,000 case differential test, not a proof.
- The console, the wallet and the owner: an owner who approves a truthfully shown bad payment is not stopped by any of this.

## What is proven

### 1. A payment is allowed only to a recipient that the owner, the address book or the owner's policy named, never to one that came from model output or untrusted text, and the recipient must be in the address book.

- Lean theorems: `p2_p15_allowed_recipient_trusted`, `p3_allowed_in_book`, `p6_lying_book_not_allowed`
- Kani harnesses: `p02_p15_allowed_recipient_trust_set`, `p03_allowed_recipient_in_book`, `p06_lying_book_label_blocked`
- Bound: Every amount, every label set, every limit combination.
- Not covered: Whether the labels are right. The gate trusts the label sets it is given.
- Files: `proofs/Verdict.lean`, `contracts/airlock-verdict/harnesses.toml`
- Claims: [C5] [C7b]

### 2. A payment whose very existence depended on an untrusted value (it sits inside an untrusted branch or loop) is never allowed.

- Lean theorems: `p1_untrusted_pc_not_allowed`
- Kani harnesses: `p01_untrusted_pc_never_allowed`
- Bound: Every amount, every label set, every limit combination.
- Not covered: Whether the runtime marks such a payment correctly; see the interpreter entry below for the model of that.
- Files: `proofs/Verdict.lean`, `contracts/airlock-verdict/harnesses.toml`
- Claims: [C5] [C7b]

### 3. An amount that came from untrusted text is allowed only to a payee with a cap, at or under that cap and at or under the payee's remaining untrusted budget.

- Lean theorems: `p4_p14_p23_untrusted_amount_bounded`
- Kani harnesses: `p04_p14_p23_untrusted_amount_inside_cap_and_budget`
- Bound: Every amount, every label set, every limit combination.
- Not covered: Amounts the owner typed or the policy set are not held to the untrusted budget, only to the other limits.
- Files: `proofs/Verdict.lean`, `contracts/airlock-verdict/harnesses.toml`
- Claims: [C5] [C7b]

### 4. A request with no provenance for its recipient, its amount or its control flow is never allowed.

- Lean theorems: `p9_p20_missing_not_allowed`
- Kani harnesses: `p09_p20_missing_provenance_never_allowed`
- Bound: Every amount, every label set with one empty, every limit combination.
- Not covered: Nothing beyond the gate's inputs: the gate cannot see how the labels were produced.
- Files: `proofs/Verdict.lean`, `contracts/airlock-verdict/harnesses.toml`
- Claims: [C5] [C7b]

### 5. No payment of an unregistered asset, while paused, of zero, above the hard cap, above what is left of the day's cap, or with a fee or gas above its cap is ever allowed, whatever the labels say.

- Lean theorems: `allow_iff`
- Kani harnesses: `p05_p10_p18_limits_hold_for_any_labels`
- Bound: Every amount, every label set, every limit combination.
- Not covered: The chain's real fee at signing time; the caps are the owner's numbers, not the network's.
- Files: `proofs/Verdict.lean`, `contracts/airlock-verdict/harnesses.toml`
- Claims: [C5] [C7b]

### 6. No payment is allowed without an open owner-signed task, or above what is left of that task's bound or of the payee's own limit.

- Lean theorems: `p21_allowed_in_task_bound`, `p22_allowed_in_payee_limit`
- Kani harnesses: `p21_allowed_inside_task_bound`, `p22_allowed_within_payee_limit`
- Bound: Every amount, every label set, every limit combination.
- Not covered: Whether the owner chose sensible bounds.
- Files: `proofs/Verdict.lean`, `contracts/airlock-verdict/harnesses.toml`
- Claims: [C5] [C7b]

### 7. Adding untrusted labels to a well-formed request, or tightening any limit, never turns a request that was not allowed into an allowed one.

- Lean theorems: `p7_taint_monotone`
- Kani harnesses: `p07_more_taint_never_allows`, `p11_tightening_never_opens`
- Bound: Every amount, every label set, every pair of loose and tight limits.
- Not covered: Well-formed means every label set is non-empty; an empty set is covered by the missing-provenance line instead.
- Files: `proofs/Verdict.lean`, `contracts/airlock-verdict/harnesses.toml`
- Claims: [C5] [C7b]

### 8. The verdict always returns Allow, Escalate or Block: it never panics and never overflows, for any input.

- Kani harnesses: `p08_total`
- Bound: Every amount, every label set, every limit combination.
- Not covered: Out-of-gas or other host failures of the contract around the verdict.
- Files: `contracts/airlock-verdict/harnesses.toml`
- Claims: [C5]

### 9. Every allow and every approval is charged to the budget, day and task ledgers, none of them can pass its cap, a refund restores them exactly, and a batch decides no more than the same requests one at a time.

- Kani harnesses: `p13_spend_exact_and_total`, `l1_untrusted_budget_holds`, `l2_asset_daily_holds`, `l3_task_bound_holds`, `l4_charge_then_refund_restores`, `l5_batch_equals_sequential_within_bounds`
- Bound: Every amount, label set and asset limit; one step, two steps or three steps as named per harness in docs/harnesses.md.
- Not covered: Checked from any state inside the caps for one to three steps, which extends to any length because the step is inductive while the caps stay fixed; the contract's storage code is tested, not proven.
- Files: `contracts/airlock-verdict/harnesses.toml`, `docs/harnesses.md`
- Claims: [C5] [C9]

### 10. An owner approval executes only if the live limits still hold, and changing any one of the five approve arguments makes it revert with that argument's own error.

- Kani harnesses: `p12_recheck_ok_implies_limits`, `approve_each_field_mismatch`
- Bound: Per harness, listed in docs/harnesses.md.
- Not covered: The harness uses stored strings of 1 to 6 bytes and three literal amounts; longer strings are covered by the sandbox tests, not by the proof.
- Files: `contracts/airlock-verdict/harnesses.toml`, `docs/harnesses.md`
- Claims: [C5] [C8a]

### 11. A flood of escalations cannot grow the pending queue past its cap or the hourly budget, nothing is stored while an agent is locked, and three consecutive rejects lock the agent.

- Kani harnesses: `flood_locked_never_stores`, `flood_pending_never_exceeds_max`, `flood_three_consecutive_rejects_lock`, `flood_hourly_budget_holds`
- Bound: Any legal sequence of 3 to 6 events, as named per harness.
- Not covered: The owner is still asked up to the caps; the availability channel stays open (docs/KNOWN_LIMITATIONS.md).
- Files: `contracts/airlock-verdict/harnesses.toml`
- Claims: [C5]

### 12. A label name or payee key is accepted only in its one canonical form, with no non-ASCII bytes, and a decimal amount text is accepted only if it is exactly the canonical text of its value.

- Kani harnesses: `p17_label_conversion_closed`, `p17b_to_name_from_name_roundtrip`, `p16_non_ascii_never_accepted_near`, `p16_non_ascii_never_accepted_evm`, `p16_validated_key_is_canonical_fixed_point`, `p16_evm_canonical_round_trip`, `placement_round_trip`, `formatted_text_is_canonical`, `parse_digits_never_panics`
- Bound: Per harness, listed in docs/harnesses.md.
- Not covered: Digit-level and short-text bounds: the full 40 digit width is covered by unit tests, not the proof (bounds per harness in docs/harnesses.md).
- Files: `contracts/airlock-verdict/harnesses.toml`, `docs/harnesses.md`
- Claims: [C5] [C12]

### 13. The proofs are not empty: Allow and every one of the 14 Escalate and Block reasons are reachable, and two rejected designs (a batch judged against one snapshot, approvals that charge nothing) are shown to break the limits.

- Kani harnesses: `cover_every_reason`, `l6a_naive_snapshot_batch_exceeds_task_bound`, `l6b_uncharged_approvals_exceed_daily_cap`
- Bound: Every amount, every label set, every limit combination.
- Not covered: Reachability shows the harnesses constrain nothing that hides a reason; it says nothing new about safety.
- Files: `contracts/airlock-verdict/harnesses.toml`
- Claims: [C5]

### 14. In the Lean model of the plan interpreter, changing untrusted data cannot change which recipients are paid by trusted actions, nor those payments.

- Lean theorems: `trusted_payments_independent_of_untrusted`, `trusted_recipients_independent_of_untrusted`
- Bound: Any stores, any plan of the model's statements, any two untrusted inputs that both complete.
- Not covered: This is a model: values are numbers with a taint bit, there is no say or tool arguments, and a run that aborts is outside the theorem. The differences from the shipped TypeScript are listed in docs/KNOWN_LIMITATIONS.md; the TypeScript is covered by a property test only. Timing and exception channels are open.
- Files: `proofs/NI.lean`, `proofs/NI_recipients.lean`
- Claims: [C1a]

### 15. The Lean model of the verdict and the Rust verdict return the same answer on 40,000 generated requests, so the theorems are about the same rules the contract runs.

- Differential test: `identical on 40000 cases`
- Bound: 40,000 generated cases.
- Not covered: Testing, not proof: 40,000 vectors (uniform, boundary and one-field toggles) show agreement on those vectors only. The Kani proofs on the Rust itself are what cover every input.
- Files: `scripts/diff-verdict.sh`, `scripts/gen_verdict_cases.py`
- Claims: [C7a]

# Terms of the AIRLOCK credit pool

As in force on 10 November 2026. Generated from `docs/terms.json` by `scripts/terms-check.ts --write`; `scripts/terms-check.ts` checks every citation below.

Each term links to the line that enforces it, the proof or test that covers it, and a transaction that shows it; the limits are terms too.

## Parties

These terms bind the pool, the card it funds, the issuer who runs both, the borrower who holds the card, and every lender who deposits. Each contract signs with the hash of the code it runs, read from the chain on 10 November 2026.

- The pool: `pool.airlock-credit-c1108d`, code hash `38ECVv72iiyNuNW5FBBu2vDK6do46FZUEiKYskLeMyAY`
- The card: `card.airlock-credit-c1108d`, code hash `6FCZRf51teMBxkLb2V5sc5bpLXDWws9RZgT3ERaUowTg`
- The issuer: `airlock-credit-c1108d`
- The borrower: `borrower.airlock-credit-c1108d`
- The agent: `agent.airlock-credit-c1108d`

Code hashes: `docs/EVIDENCE.md` line 350.

## 1. What the card and the pool do

**1.1** Money leaves the card for a payee the issuer put in the card's address book, or goes back to the pool. *(in force)*

- Enforced: `contracts/airlock-verdict/src/lib.rs` 218 to 222, `rule 9`
- Enforced: `contracts/airlock-policy/src/roles.rs` 78 to 109, `sweep pays the sponsor`
- Proved: `proofs/Verdict.lean` 115, `p3_allowed_in_book`
- Proved: `proofs/Verdict.lean` 12, `allow_iff`
- Kani: `contracts/airlock-verdict/src/proofs.rs` 127, `p03_allowed_recipient_in_book`
- Shown: an injected payee held, transaction `BNq34shewEcee6haPAuGoaR9fxFz8mXS2fhu6WUpYNpY` (`docs/EVIDENCE.md` line 373)
- Shown: a sweep back to the pool, transaction `25rQep4msvH5K1YFaJvuEupCEUbqtbQysjgSUy9BcVpW` (`docs/EVIDENCE.md` line 378)

**1.2** A hijacked agent cannot choose the payee: a payee picked by outside text is held for a person to decide. *(in force)*

- Enforced: `contracts/airlock-verdict/src/lib.rs` 214 to 217, `rule 8`
- Proved: `proofs/Verdict.lean` 105, `p2_p15_allowed_recipient_trusted`
- Kani: `contracts/airlock-verdict/src/proofs.rs` 117, `p02_p15_allowed_recipient_trust_set`
- Shown: an injected payee held, transaction `BNq34shewEcee6haPAuGoaR9fxFz8mXS2fhu6WUpYNpY` (`docs/EVIDENCE.md` line 373)

**1.3** The borrower cannot approve a payment to an account outside the book; the issuer can override it, and either of them can reject it. *(in force)*

- Enforced: `contracts/airlock-policy/src/roles.rs` 42 to 56, `require_settle_role`
- Enforced: `contracts/airlock-policy/src/escalation.rs` 447 to 451, `the borrower cannot add payees`
- Tested: `contracts/airlock-policy/src/redteam.rs` 519, `rt_con_borrower_pays_himself_is_refused`
- Tested: `docs/CLAIMS.md` 38, `claim C21`
- Shown: the borrower's approve of his own account refused, transaction `12VC9dH5f9n7RLRq2h8uDAQDSw2upBwwDygDzjuU69iy` (`docs/EVIDENCE.md` line 375)

**1.4** An amount read from outside text is never paid on the card; it is held for the owner, because no payee in the card's book has a cap for such amounts. *(in force)*

- Enforced: `contracts/airlock-verdict/src/lib.rs` 227 to 237, `rule 11`
- Enforced: `contracts/airlock-policy/src/policy.rs` 297, `a payee without a cap`
- Proved: `proofs/Verdict.lean` 123, `p4_p14_p23_untrusted_amount_bounded`
- Kani: `contracts/airlock-verdict/src/proofs.rs` 137, `p04_p14_p23_untrusted_amount_inside_cap_and_budget`
- Measured: `docs/BENCH.md` 37, `strict mode paid 0 of 250 attack runs, default mode 10 of 250`
- Shown: the book without caps set on the card (epoch 2), transaction `3facSJMXLUG61w8h8AZhA2EREdx17cZ6Wks35vc94tZo`

**1.5** A payment that outside text decided to make is never paid by itself. *(in force)*

- Enforced: `contracts/airlock-verdict/src/lib.rs` 210 to 213, `rule 7`
- Proved: `proofs/Verdict.lean` 96, `p1_untrusted_pc_not_allowed`
- Kani: `contracts/airlock-verdict/src/proofs.rs` 104, `p01_untrusted_pc_never_allowed`
- Shown: a bench run held as UntrustedTrigger, `bench/runs/recorded/transcripts/own-S01.A1.1.json` 215

**1.6** Every payment fits the task the owner signed, and what is left of that task shrinks with each payment. *(in force)*

- Enforced: `contracts/airlock-verdict/src/lib.rs` 202 to 209, `rule 6`
- Proved: `proofs/Verdict.lean` 192, `p21_allowed_in_task_bound`
- Kani: `contracts/airlock-verdict/src/proofs.rs` 355, `p21_allowed_inside_task_bound`
- Kani: `contracts/airlock-verdict/src/ledger.rs` 385, `l3_task_bound_holds`
- Shown: a payment allowed inside its task, transaction `5TKhYsPcH8QFoGtXxqRVKCsJfvePgFxUTAXaF7V8vuG` (`docs/EVIDENCE.md` line 372)

**1.7** A plain transfer to the pool cannot move the share price. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 3 to 5, `own accounting fields`
- Enforced: `contracts/airlock-credit/src/lib.rs` 290 to 293, `assets_at`
- Tested: `contracts/airlock-credit/src/tests.rs` 174, `a_plain_transfer_to_the_contract_cannot_move_the_share_price`

**1.8** Deposits and withdrawals price a share the same way, and every rounding goes in the pool's favour. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 482, `deposit`
- Enforced: `contracts/airlock-credit/src/lib.rs` 517 to 519, `withdraw`
- Enforced: `contracts/airlock-credit/src/math.rs` 54 to 70, `share math`
- Tested: `contracts/airlock-credit/src/math.rs` 247, `withdraw_rounds_down_and_never_pays_more_than_pro_rata`
- Tested: `contracts/airlock-credit/src/math.rs` 258, `deposit_then_withdraw_never_gains`
- Tested: `contracts/airlock-credit/src/tests.rs` 1046, `property_random_operations_keep_the_accounting`
- Shown: a lender's 3 NEAR withdrawn as 3.03 NEAR, transaction `5qLww3EW9EfCJnZ5kkhs4BCzzskw3doYFabYMJ34agEs` (`docs/EVIDENCE.md` line 380)

**1.9** An overdue line counts as zero in the share price before anyone calls default, and deposits stay closed while a line is overdue or a loss is unrecovered. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 271 to 278, `impaired_at`
- Enforced: `contracts/airlock-credit/src/lib.rs` 476 to 483, `deposit`
- Tested: `contracts/airlock-credit/src/tests.rs` 768, `an_overdue_line_is_impaired_in_the_share_price_before_anyone_calls_default`
- Tested: `contracts/airlock-credit/src/tests.rs` 429, `deposits_are_refused_while_a_line_is_past_due_and_reopen_after_default`
- Tested: `contracts/airlock-credit/src/tests.rs` 666, `deposits_stay_closed_between_a_default_and_its_recovery`
- Shown: a deposit refused while a line was past due, transaction `5n4ZoQW6fe5KSd7SqNunDWwRQhe4xLepH5ZmjfH9dgon` (`docs/EVIDENCE.md` line 383)
- Shown: a deposit refused before a loss was recovered, transaction `6Hzfv7JbAobTBbNMr7x8PuuCbDgN3JQt5y5Xg4w6eTQs` (`docs/EVIDENCE.md` line 385)

**1.10** A lender's shares can be withdrawn by that lender alone, once the hold has passed, from money the pool holds idle. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 496 to 519, `withdraw`
- Tested: `contracts/airlock-credit/src/tests.rs` 190, `withdraw_pays_the_pro_rata_amount_down_to_idle_and_refuses_beyond`
- Tested: `contracts/airlock-credit/src/tests.rs` 723, `shares_are_held_for_min_hold_ms_after_a_deposit`
- Shown: a lender withdraws all its shares, transaction `5qLww3EW9EfCJnZ5kkhs4BCzzskw3doYFabYMJ34agEs` (`docs/EVIDENCE.md` line 380)

**1.11** On default the collateral pays the principal before the fee, and what it does not cover is a loss to the lenders. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 960 to 997, `default`
- Tested: `contracts/airlock-credit/src/tests.rs` 524, `default_seizes_collateral_principal_first_and_books_the_rest_as_a_loss`
- Tested: `contracts/airlock-credit/src/tests.rs` 546, `default_with_collateral_above_what_is_owed_returns_the_rest`
- Shown: a default: collateral seized, the rest a loss, transaction `6Pk6PR71dnoPJGjxy1CpQWNGkdgE6a7DmEec5ZnJQcxA` (`docs/EVIDENCE.md` line 384)

## 2. Limits

**2.1** The issuer books the payees, and the issuer can approve a held payment to a payee outside the book. This has not been done on chain. *(in force)*

- Enforced: `contracts/airlock-policy/src/roles.rs` 42 to 56, `require_settle_role`
- Enforced: `contracts/airlock-policy/src/policy.rs` 478, `book_set_root`
- Tested: `contracts/airlock-policy/src/redteam.rs` 519, `rt_con_borrower_pays_himself_is_refused`

**2.2** A booked merchant that colludes with the borrower can keep what it is paid. Nothing in the code prevents this. *(in force)*

**2.3** The pool and the card each hold one full-access key, held by the operator, so the operator can deploy new code to either. The agent holds a full-access key to its own account and a function-call key that can call submit_batch and expire on the card. *(in force)*

- Shown: the agent's function-call key added on the card, transaction `FAyo8RPPeUU67nTGgKi7kVStb1YtYs2wnFFMn8bV3m1m`

**2.4** The fee is charged on what the card kept, so a sweep before the repay lowers it, and a card that returns everything owes no fee. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 952 to 955, `repay`
- Tested: `contracts/airlock-credit/src/tests.rs` 480, `repay_charges_the_fee_on_what_the_card_kept_and_returns_the_collateral`
- Tested: `contracts/airlock-credit/src/tests.rs` 512, `a_fully_swept_line_owes_nothing`
- Shown: a repay of 0.5 NEAR kept plus its 10 percent fee, transaction `N2344KkGfQG5e3L7p6jwDL8bonzcPoT8mvdqFNhvEi8` (`docs/EVIDENCE.md` line 379)

**2.5** The issuer sets the terms of new lines. The collateral ratio of new lines changes at once in either direction, and open lines keep theirs. From the upgrade, a cut of the Passport base applies at once and a raise waits for the hold, 60 seconds on this pool. A cut does not lower the draw a repay must keep to count toward the score, and the cap counts what one borrower account holds across all its cards. *(from the upgrade)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 1034 to 1039, `set_collateral_bps`
- Tested: `contracts/airlock-credit/src/tests.rs` 578, `the_collateral_ratio_is_the_owner_s_and_open_lines_keep_theirs`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1046, `set_passport_base`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1065, `apply_passport_base`
- Enforced: `contracts/airlock-credit/src/lib.rs` 715, `open_line refuses a limit above the cap`
- Tested: `contracts/airlock-credit/src/tests.rs` 1575, `a_lower_base_applies_at_once_a_raise_only_after_min_hold_ms`
- Tested: `contracts/airlock-credit/src/tests.rs` 1532, `open_line_above_the_cap_is_refused_then_allowed_after_an_on_time_repay`
- Tested: `contracts/airlock-credit/src/tests.rs` 1359, `ten_dust_lines_kept_in_full_do_not_raise_the_score`
- Tested: `contracts/airlock-credit/src/tests.rs` 1425, `a_cut_of_the_base_does_not_lower_the_draw_a_repay_needs_to_count`
- Tested: `contracts/airlock-credit/src/tests.rs` 1462, `the_cap_counts_what_the_borrower_holds_on_their_other_cards`

**2.6** Lenders can leave 60 seconds after a deposit on this pool, and then for as much as the pool holds idle; money lent out waits for its repayment. Collateral is 30 percent of a line, and the pool bears any loss beyond it. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 523 to 527, `withdraw`
- Enforced: `contracts/airlock-credit/src/lib.rs` 35 to 36, `collateral ratio`
- Measured: `docs/EVIDENCE.md` 390, `the pool's hold, read from the chain`

**2.7** All of this runs on NEAR's test network with test money. The issuer, the borrower, the merchant and the agent are the team's own accounts, and so are the two lenders of the recorded run. *(in force)*

- Measured: `docs/EVIDENCE.md` 350, `the accounts of the run`

**2.8** The pool's terms rest on tests, not proofs. The Lean theorems and the Kani harnesses cover the payment gate of the card, the verdict function, and not the credit pool: terms 1.7 to 1.11 and limits 2.4 to 2.6 cite tests. *(in force)*

- Tested: `contracts/airlock-credit/src/tests.rs` 1046, `the pool's property test`

**2.9** An hourly loop borrows 0.09 NEAR from the pool, pays the booked merchant and repays with a 10 percent fee. Its borrower and merchant are the team's accounts, so the fee the lenders earn from it is the team's own money. *(in force)*

- Enforced: `runtime/src/economy/facts.ts` 1 to 3, `the loop's accounts`
- Enforced: `runtime/src/economy/facts.ts` 24 to 26, `0.09 NEAR at 10 percent`
- Shown: the loop's repay with its fee, transaction `C3ZKyFdahsiHExAertB1XSubq3LLcQQuEG9xJvKvfwpJ`

## Schedule of cited files

- `bench/runs/recorded/transcripts/own-S01.A1.1.json`: 215
- `contracts/airlock-credit/src/lib.rs`: 3 to 5, 35 to 36, 271 to 278, 290 to 293, 476 to 483, 482, 496 to 519, 517 to 519, 523 to 527, 715, 952 to 955, 960 to 997, 1034 to 1039, 1046, 1065
- `contracts/airlock-credit/src/math.rs`: 54 to 70, 247, 258
- `contracts/airlock-credit/src/tests.rs`: 174, 190, 429, 480, 512, 524, 546, 578, 666, 723, 768, 1046, 1359, 1425, 1462, 1532, 1575
- `contracts/airlock-policy/src/escalation.rs`: 447 to 451
- `contracts/airlock-policy/src/policy.rs`: 297, 478
- `contracts/airlock-policy/src/redteam.rs`: 519
- `contracts/airlock-policy/src/roles.rs`: 42 to 56, 78 to 109
- `contracts/airlock-verdict/src/ledger.rs`: 385
- `contracts/airlock-verdict/src/lib.rs`: 202 to 209, 210 to 213, 214 to 217, 218 to 222, 227 to 237
- `contracts/airlock-verdict/src/proofs.rs`: 104, 117, 127, 137, 355
- `docs/BENCH.md`: 37
- `docs/CLAIMS.md`: 38
- `docs/EVIDENCE.md`: 350, 372, 373, 375, 378, 379, 380, 383, 384, 385, 390
- `proofs/Verdict.lean`: 12, 96, 105, 115, 123, 192
- `runtime/src/economy/facts.ts`: 1 to 3, 24 to 26

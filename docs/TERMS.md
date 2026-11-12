# Terms of the AIRLOCK credit pool

As in force on 12 November 2026. Generated from `docs/terms.json` by `scripts/terms-check.ts --write`; `scripts/terms-check.ts` checks every citation below.

Each term links to the line that enforces it, the proof or test that covers it, and a transaction that shows it; the limits are terms too.

## Parties

These terms bind the pool, the card it funds, the issuer who runs both, the borrower who holds the card, and every lender who deposits. Each contract signs with the hash of the code it runs, read from the chain on 12 November 2026.

- The pool: `pool.airlock-credit-c1108d`, code hash `5DEnqxwBiVwsxuXNzYeE3a9P4DLYuSj2pjnQKvY88xyN`
- The card: `card.airlock-credit-c1108d`, code hash `79BH9QUuWjxt4SggfgD66maVb7m2ckg5HHq3aB5pKGX7`
- The issuer: `airlock-credit-c1108d`
- The borrower: `borrower.airlock-credit-c1108d`
- The agent: `agent.airlock-credit-c1108d`

Code hashes: `docs/EVIDENCE.md` line 589.

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
- Enforced: `contracts/airlock-policy/src/escalation.rs` 491 to 495, `the borrower cannot add payees`
- Tested: `contracts/airlock-policy/src/redteam.rs` 519, `rt_con_borrower_pays_himself_is_refused`
- Tested: `docs/CLAIMS.md` 38, `claim C21`
- Shown: the borrower's approve of his own account refused, transaction `12VC9dH5f9n7RLRq2h8uDAQDSw2upBwwDygDzjuU69iy` (`docs/EVIDENCE.md` line 375)

**1.4** An amount read from outside text is never paid by itself on the card: it is held, because no payee in the card's book has a cap for such amounts. The borrower may approve it for a booked merchant inside what is left of the issuer's task bound and of the merchant's daily limit, and his approve is refused outside them. *(in force)*

- Enforced: `contracts/airlock-verdict/src/lib.rs` 227 to 237, `rule 11`
- Enforced: `contracts/airlock-policy/src/policy.rs` 297, `a payee without a cap`
- Enforced: `contracts/airlock-policy/src/escalation.rs` 244 to 278, `require_approver_within_bounds`
- Tested: `contracts/airlock-policy/src/redteam.rs` 1278, `rt_con_approver_cannot_approve_past_the_payee_daily_limit`
- Proved: `proofs/Verdict.lean` 123, `p4_p14_p23_untrusted_amount_bounded`
- Kani: `contracts/airlock-verdict/src/proofs.rs` 137, `p04_p14_p23_untrusted_amount_inside_cap_and_budget`
- Measured: `docs/BENCH.md` 37, `strict mode paid 0 of 250 attack runs, default mode 10 of 250`
- Shown: the book without caps set on the card (epoch 2), transaction `3facSJMXLUG61w8h8AZhA2EREdx17cZ6Wks35vc94tZo`

**1.5** A payment that outside text decided to make is never paid by itself. *(in force)*

- Enforced: `contracts/airlock-verdict/src/lib.rs` 210 to 213, `rule 7`
- Proved: `proofs/Verdict.lean` 96, `p1_untrusted_pc_not_allowed`
- Kani: `contracts/airlock-verdict/src/proofs.rs` 104, `p01_untrusted_pc_never_allowed`
- Shown: a bench run held as UntrustedTrigger, `bench/runs/recorded/transcripts/own-S01.A1.1.json` 215

**1.6** Every payment the agent makes or the borrower approves fits the task the issuer signed, and what is left of that task shrinks with each payment. The borrower cannot approve a held payment outside that task, above what is left of its bound, or above the merchant's daily limit; the issuer's override of a payee outside the book is the one approval that passes them (limit 2.1). *(in force)*

- Enforced: `contracts/airlock-verdict/src/lib.rs` 202 to 209, `rule 6`
- Enforced: `contracts/airlock-policy/src/escalation.rs` 244 to 278, `require_approver_within_bounds`
- Tested: `contracts/airlock-policy/src/redteam.rs` 1246, `rt_con_approver_cannot_approve_past_the_task_bound`
- Tested: `contracts/airlock-policy/src/redteam.rs` 1303, `rt_con_approver_cannot_approve_past_what_is_left_of_the_task_bound`
- Tested: `contracts/airlock-policy/tests/approver_bounds.rs` 113, `lane1_borrower_cannot_approve_past_the_issuers_task_bound`
- Tested: `contracts/airlock-policy/tests/approver_bounds.rs` 134, `lane1_borrower_cannot_approve_a_payee_outside_the_signed_task`
- Proved: `proofs/Verdict.lean` 192, `p21_allowed_in_task_bound`
- Kani: `contracts/airlock-verdict/src/proofs.rs` 355, `p21_allowed_inside_task_bound`
- Kani: `contracts/airlock-verdict/src/ledger.rs` 385, `l3_task_bound_holds`
- Shown: a payment allowed inside its task, transaction `5TKhYsPcH8QFoGtXxqRVKCsJfvePgFxUTAXaF7V8vuG` (`docs/EVIDENCE.md` line 372)

**1.7** A plain transfer to the pool cannot move the share price. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 3 to 5, `own accounting fields`
- Enforced: `contracts/airlock-credit/src/lib.rs` 387 to 390, `assets_at`
- Tested: `contracts/airlock-credit/src/tests.rs` 179, `a_plain_transfer_to_the_contract_cannot_move_the_share_price`

**1.8** Deposits and withdrawals price a share the same way, and every rounding goes in the pool's favour. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 599, `deposit`
- Enforced: `contracts/airlock-credit/src/lib.rs` 633 to 635, `withdraw`
- Enforced: `contracts/airlock-credit/src/math.rs` 54 to 70, `share math`
- Tested: `contracts/airlock-credit/src/math.rs` 247, `withdraw_rounds_down_and_never_pays_more_than_pro_rata`
- Tested: `contracts/airlock-credit/src/math.rs` 258, `deposit_then_withdraw_never_gains`
- Tested: `contracts/airlock-credit/src/tests.rs` 1316, `property_random_operations_keep_the_accounting`
- Shown: a lender's 3 NEAR withdrawn as 3.03 NEAR, transaction `5qLww3EW9EfCJnZ5kkhs4BCzzskw3doYFabYMJ34agEs` (`docs/EVIDENCE.md` line 380)

**1.9** An overdue line counts as zero in the share price before anyone calls default, and deposits stay closed while a line is overdue or a loss is unrecovered. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 372 to 379, `impaired_at`
- Enforced: `contracts/airlock-credit/src/lib.rs` 585 to 592, `deposit`
- Tested: `contracts/airlock-credit/src/tests.rs` 1002, `an_overdue_line_is_impaired_in_the_share_price_before_anyone_calls_default`
- Tested: `contracts/airlock-credit/src/tests.rs` 657, `deposits_are_refused_while_a_line_is_past_due_and_reopen_after_default`
- Tested: `contracts/airlock-credit/src/tests.rs` 894, `deposits_stay_closed_between_a_default_and_its_recovery`
- Shown: a deposit refused while a line was past due, transaction `5n4ZoQW6fe5KSd7SqNunDWwRQhe4xLepH5ZmjfH9dgon` (`docs/EVIDENCE.md` line 383)
- Shown: a deposit refused before a loss was recovered, transaction `6Hzfv7JbAobTBbNMr7x8PuuCbDgN3JQt5y5Xg4w6eTQs` (`docs/EVIDENCE.md` line 385)

**1.10** A lender's shares can be withdrawn by that lender alone, once the hold has passed, from money the pool holds idle. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 618 to 641, `withdraw`
- Tested: `contracts/airlock-credit/src/tests.rs` 195, `withdraw_pays_the_pro_rata_amount_down_to_idle_and_refuses_beyond`
- Tested: `contracts/airlock-credit/src/tests.rs` 957, `shares_are_held_for_min_hold_ms_after_a_deposit`
- Shown: a lender withdraws all its shares, transaction `5qLww3EW9EfCJnZ5kkhs4BCzzskw3doYFabYMJ34agEs` (`docs/EVIDENCE.md` line 380)

**1.11** On default the collateral pays the principal before the fee, and what it does not cover is a loss to the lenders. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 1123 to 1160, `default`
- Tested: `contracts/airlock-credit/src/tests.rs` 752, `default_seizes_collateral_principal_first_and_books_the_rest_as_a_loss`
- Tested: `contracts/airlock-credit/src/tests.rs` 774, `default_with_collateral_above_what_is_owed_returns_the_rest`
- Shown: a default: collateral seized, the rest a loss, transaction `6Pk6PR71dnoPJGjxy1CpQWNGkdgE6a7DmEec5ZnJQcxA` (`docs/EVIDENCE.md` line 384)

**1.12** A lender with no entry in the pool pays 0.0025 NEAR for that entry in the pool's storage, out of the amount attached to its deposit; the pool credits the rest, which must be at least 0.001 NEAR. The charge is not pool money and is not refunded, and withdrawing every share removes the entry. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 33 to 36, `LP_STORAGE`
- Enforced: `contracts/airlock-credit/src/lib.rs` 593 to 597, `deposit`
- Enforced: `contracts/airlock-credit/src/lib.rs` 642 to 646, `withdraw`
- Tested: `contracts/airlock-credit/src/tests.rs` 247, `a_first_deposit_pays_the_storage_charge_and_a_second_is_credited_in_full`
- Tested: `contracts/airlock-credit/src/tests.rs` 285, `a_first_deposit_must_cover_the_minimum_and_the_charge`
- Tested: `contracts/airlock-credit/src/tests.rs` 303, `the_storage_charge_never_moves_the_share_price`
- Tested: `contracts/airlock-credit/src/tests.rs` 328, `a_full_withdraw_removes_both_entries_and_a_partial_keeps_them`
- Tested: `contracts/airlock-credit/tests/pool.rs` 1190, `the_storage_fix_redeploys_over_a_v2_pool_with_no_init_call`
- Shown: a deposit of 0.003 NEAR by a new lender refused, transaction `AC3T5NXnAWQ796wDFGfg4QVtkHhrJNAiVaAShpHB3nnn` (`docs/EVIDENCE.md` line 566)
- Shown: a deposit of 0.1025 NEAR credited as 0.1 NEAR, transaction `5EKouAqzseLiaDNin9jxMyrJvQ6wyio4PcmPNwZoc2Lb` (`docs/EVIDENCE.md` line 567)
- Shown: a full withdrawal that freed the entry, transaction `Db7zDeaAsNcDKTarLsHQL7VM5RAqUTjgSM4icvQUzGXA` (`docs/EVIDENCE.md` line 568)

## 2. Limits

**2.1** The issuer books the payees, and the issuer can approve a held payment to a payee outside the book. That approval is bounded by the card's asset caps, not by the task bound or the payee's daily limit: it charges those two up to their limits and is not refused by them. This has not been done on chain. *(in force)*

- Enforced: `contracts/airlock-policy/src/roles.rs` 42 to 56, `require_settle_role`
- Enforced: `contracts/airlock-verdict/src/ledger.rs` 97 to 114, `apply_approval`
- Enforced: `contracts/airlock-policy/src/policy.rs` 478, `book_set_root`
- Tested: `contracts/airlock-policy/src/redteam.rs` 519, `rt_con_borrower_pays_himself_is_refused`

**2.2** A booked merchant that colludes with the borrower can keep what it is paid. Nothing in the code prevents this. *(in force)*

**2.3** The pool and the card each hold one full-access key on their own accounts, held by the team: a holder can deploy new code to either contract and move that account's balance. The agent account holds a full-access key and a function-call key whose receiver is the card, for the methods submit_batch and expire. The issuer's account holds one full-access key; the issuer is the owner in the state of the pool and of the card, and keeps the powers of limits 2.11 to 2.14 through those contracts' own methods. *(in force)*

- Shown: the function-call key added to the agent account, receiver the card, transaction `FAyo8RPPeUU67nTGgKi7kVStb1YtYs2wnFFMn8bV3m1m`

**2.4** The fee is charged on what the card kept, so a sweep before the repay lowers it, and a card that returns everything owes no fee. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 1081 to 1084, `repay`
- Tested: `contracts/airlock-credit/src/tests.rs` 708, `repay_charges_the_fee_on_what_the_card_kept_and_returns_the_collateral`
- Tested: `contracts/airlock-credit/src/tests.rs` 740, `a_fully_swept_line_owes_nothing`
- Shown: a repay of 0.5 NEAR kept plus its 10 percent fee, transaction `N2344KkGfQG5e3L7p6jwDL8bonzcPoT8mvdqFNhvEi8` (`docs/EVIDENCE.md` line 379)

**2.5** The issuer sets the terms of new lines. The collateral ratio of new lines changes at once in either direction, and open lines keep theirs. Since the pool was upgraded on 10 November 2026, a cut of the Passport base applies at once and a raise waits for the hold, 60 seconds on this pool. A cut does not lower the draw a repay must keep to count toward the score, and the cap counts what one borrower account holds across all its cards. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 1163 to 1168, `set_collateral_bps`
- Tested: `contracts/airlock-credit/src/tests.rs` 806, `the_collateral_ratio_is_the_owner_s_and_open_lines_keep_theirs`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1175, `set_passport_base`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1194, `apply_passport_base`
- Enforced: `contracts/airlock-credit/src/lib.rs` 844, `open_line refuses a limit above the cap`
- Tested: `contracts/airlock-credit/src/tests.rs` 1857, `a_lower_base_applies_at_once_a_raise_only_after_min_hold_ms`
- Tested: `contracts/airlock-credit/src/tests.rs` 1814, `open_line_above_the_cap_is_refused_then_allowed_after_an_on_time_repay`
- Tested: `contracts/airlock-credit/src/tests.rs` 1641, `ten_dust_lines_kept_in_full_do_not_raise_the_score`
- Tested: `contracts/airlock-credit/src/tests.rs` 1707, `a_cut_of_the_base_does_not_lower_the_draw_a_repay_needs_to_count`
- Tested: `contracts/airlock-credit/src/tests.rs` 1744, `the_cap_counts_what_the_borrower_holds_on_their_other_cards`
- Shown: the upgrade that set the Passport base to 1 NEAR, transaction `AXfP2CKgY31WxbBfrisb9YfKbg3q3XYad3SA9GbazzUN` (`docs/EVIDENCE.md` line 442)
- Shown: a line of 1.08 NEAR refused above the cap of 1 NEAR at score 500, transaction `BPFvcUAXnd4w9xZpaHTz8pcg7cqDyopNHAYebLaBoLqT` (`docs/EVIDENCE.md` line 443)
- Shown: the same line opened after one repay on time raised the cap to 1.16 NEAR, transaction `42r73k13VE3cjmdhgk7C5vfYxKmhGzyruayNx6UoqoaR` (`docs/EVIDENCE.md` line 450)

**2.6** Lenders can leave 60 seconds after a deposit on this pool, and then for as much as the pool holds idle; money lent out waits for its repayment. Collateral is 30 percent of a line, and the pool bears any loss beyond it. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 639 to 643, `withdraw`
- Enforced: `contracts/airlock-credit/src/lib.rs` 42 to 43, `collateral ratio`
- Measured: `docs/EVIDENCE.md` 390, `the pool's hold, read from the chain`

**2.7** All of this runs on NEAR's test network with test money, and the card's one Base payment ran on Base Sepolia with test ETH the team put on the card's Base address. The issuer, the borrower, the merchant and the agent are the team's own accounts, and so are the two lenders of the recorded run; the merchant's Base address is derived from the merchant's account. *(in force)*

- Measured: `docs/EVIDENCE.md` 350, `the accounts of the run`

**2.8** The pool's terms rest on tests, not proofs. The Lean theorems and the Kani harnesses cover the payment gate of the card, the verdict function, and not the credit pool: terms 1.7 to 1.12 and limits 2.4 to 2.6 and 2.10 to 2.14 cite tests. *(in force)*

- Tested: `contracts/airlock-credit/src/tests.rs` 1316, `the pool's property test`

**2.9** An hourly loop borrows 0.09 NEAR from the pool, pays the booked merchant and repays with a 10 percent fee. Its borrower and merchant are the team's accounts, so the fee the lenders earn from it is the team's own money. The loop runs each hour on the team's computer and skips a run when a stop rule holds, for example while a held request is pending on the card; its runs and gaps are in the evidence. *(in force)*

- Enforced: `runtime/src/economy/facts.ts` 1 to 3, `the loop's accounts`
- Enforced: `runtime/src/economy/facts.ts` 24 to 26, `0.09 NEAR at 10 percent`
- Shown: the loop's repay with its fee, transaction `C3ZKyFdahsiHExAertB1XSubq3LLcQQuEG9xJvKvfwpJ`

**2.10** Anyone who pays the pool 0.01 NEAR can have it ask the MPC signer it names whether a Base payment is final and succeeded, and the pool keeps the signed answer. A payment can be checked once Base has finalized it, about 21 minutes after the card's payment was mined. The answer binds the transaction to a block hash and names no payee and no amount. The pool does not check the signature, and no line, limit or share price depends on the answer. Two payments were checked on 10 November 2026: one made by an older account of the team, and one made by the card itself. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 1215, `check_base_payment`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1220 to 1224, `the fee of 0.01 NEAR`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1260, `on_base_check`
- Tested: `contracts/airlock-credit/src/tests.rs` 2290, `base_check_asks_the_configured_signer_with_one_yocto`
- Tested: `contracts/airlock-credit/src/tests.rs` 2338, `a_signed_answer_is_recorded_and_the_view_returns_it`
- Tested: `contracts/airlock-credit/src/tests.rs` 2428, `a_failed_check_records_nothing_and_refunds_the_fee`
- Tested: `contracts/airlock-credit/src/tests.rs` 2528, `the_base_check_fee_cannot_move_the_share_price`
- Shown: the pool records the signed answer for a Base Sepolia payment, transaction `4aMpo4V2949S9Pp25GvxwrLa7x2Fb7zKjAr9crFpgqMz` (`docs/EVIDENCE.md` line 466)
- Shown: the pool records the signed answer for the card's own Base payment, transaction `8KReKRKbYWAdmRz1dcRmw5rqR41tzhkzz75N31mLzGbQ` (`docs/EVIDENCE.md` line 512)

**2.11** The issuer registers the cards, and the pool checks a card by the answer the card account gives to get_roles: owner, approver and sponsor. The pool does not read the card's code, so the issuer can register a contract that is not an AIRLOCK card and that gives that answer. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 711 to 713, `register_card`
- Enforced: `contracts/airlock-credit/src/lib.rs` 747 to 763, `on_card_roles`
- Tested: `contracts/airlock-credit/src/tests.rs` 430, `register_card_checks_the_roles_the_card_answers`

**2.12** The issuer can lend all the money the pool holds idle to borrower accounts it names, with no waiting period: it sets the collateral ratio of new lines to 0, which applies at once, registers one card for each new borrower account (the pool holds 100 cards at most), each account's cap being the Passport base (1 NEAR on this pool), and opens a line on each card, due up to 90 days later. With one card instead, it announces a raise of the base, which applies 60 seconds later on this pool, and opens one line for everything. Lenders can withdraw no more than the pool holds idle, so they wait for those lines to be repaid or to default. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 1163 to 1168, `set_collateral_bps`
- Enforced: `contracts/airlock-credit/src/lib.rs` 841 to 847, `open_line refuses a limit above the cap`
- Enforced: `contracts/airlock-credit/src/lib.rs` 896 to 905, `open_line needs collateral and idle money`
- Enforced: `contracts/airlock-credit/src/math.rs` 153 to 155, `limit_cap`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1184, `set_passport_base`
- Enforced: `contracts/airlock-credit/src/lib.rs` 636 to 640, `withdraw`
- Tested: `contracts/airlock-credit/src/tests.rs` 806, `the_collateral_ratio_is_the_owner_s_and_open_lines_keep_theirs`
- Tested: `contracts/airlock-credit/src/tests.rs` 1744, `the_cap_counts_what_the_borrower_holds_on_their_other_cards`

**2.13** A raise of the Passport base that has applied also raises, for good, the draw a repay must keep to count toward a score, a tenth of the highest base so far; no call lowers it. The issuer can cancel a raise while it is pending, and anyone can apply it once it is due. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 1175 to 1191, `set_passport_base`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1203, `apply_passport_base`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1092, `repay`
- Tested: `contracts/airlock-credit/src/tests.rs` 1707, `a_cut_of_the_base_does_not_lower_the_draw_a_repay_needs_to_count`

**2.14** A loss that is not recovered keeps deposits closed for every lender. Two calls clear it, and both need the issuer's key: write_off on the pool, and sweep on an AIRLOCK card, whose money the pool credits as a recovery. If the issuer's key is lost, no call of either contract clears such a loss and deposits stay closed for good, while withdrawals of idle money go on; as long as the card account keeps its own key, new card code could still return the money. *(in force)*

- Enforced: `contracts/airlock-credit/src/lib.rs` 381 to 384, `has_unrecovered_loss`
- Enforced: `contracts/airlock-credit/src/lib.rs` 588 to 591, `deposit`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1005 to 1006, `write_off`
- Enforced: `contracts/airlock-policy/src/roles.rs` 78 to 79, `sweep`
- Enforced: `contracts/airlock-credit/src/lib.rs` 1022 to 1026, `on_card_return`
- Tested: `contracts/airlock-credit/src/tests.rs` 894, `deposits_stay_closed_between_a_default_and_its_recovery`

## Schedule of cited files

- `bench/runs/recorded/transcripts/own-S01.A1.1.json`: 215
- `contracts/airlock-credit/src/lib.rs`: 3 to 5, 33 to 36, 42 to 43, 372 to 379, 381 to 384, 387 to 390, 585 to 592, 588 to 591, 593 to 597, 599, 618 to 641, 633 to 635, 636 to 640, 639 to 643, 642 to 646, 711 to 713, 747 to 763, 841 to 847, 844, 896 to 905, 1005 to 1006, 1022 to 1026, 1081 to 1084, 1092, 1123 to 1160, 1163 to 1168, 1175, 1175 to 1191, 1184, 1194, 1203, 1215, 1220 to 1224, 1260
- `contracts/airlock-credit/src/math.rs`: 54 to 70, 153 to 155, 247, 258
- `contracts/airlock-credit/src/tests.rs`: 179, 195, 247, 285, 303, 328, 430, 657, 708, 740, 752, 774, 806, 894, 957, 1002, 1316, 1641, 1707, 1744, 1814, 1857, 2290, 2338, 2428, 2528
- `contracts/airlock-credit/tests/pool.rs`: 1190
- `contracts/airlock-policy/src/escalation.rs`: 244 to 278, 491 to 495
- `contracts/airlock-policy/src/policy.rs`: 297, 478
- `contracts/airlock-policy/src/redteam.rs`: 519, 1246, 1278, 1303
- `contracts/airlock-policy/src/roles.rs`: 42 to 56, 78 to 109, 78 to 79
- `contracts/airlock-policy/tests/approver_bounds.rs`: 113, 134
- `contracts/airlock-verdict/src/ledger.rs`: 97 to 114, 385
- `contracts/airlock-verdict/src/lib.rs`: 202 to 209, 210 to 213, 214 to 217, 218 to 222, 227 to 237
- `contracts/airlock-verdict/src/proofs.rs`: 104, 117, 127, 137, 355
- `docs/BENCH.md`: 37
- `docs/CLAIMS.md`: 38
- `docs/EVIDENCE.md`: 350, 372, 373, 375, 378, 379, 380, 383, 384, 385, 390, 442, 443, 450, 466, 512, 566, 567, 568, 589
- `proofs/Verdict.lean`: 12, 96, 105, 115, 123, 192
- `runtime/src/economy/facts.ts`: 1 to 3, 24 to 26

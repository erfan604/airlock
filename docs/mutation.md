# Mutation testing of the verdict crate

`scripts/mutation.sh` runs cargo-mutants 26.0.0 on `contracts/airlock-verdict` (config: `contracts/airlock-verdict/.cargo/mutants.toml`).
Each mutant is tested with the whole `cargo test` of the crate, including `tests/diff_quick.rs`, which compares the Rust verdict with the
Lean runner on 2,000 fixed cases. A mutant that makes a test hang ends in a timeout, which counts as a detection. A survivor is then
re-checked with Kani on the harness group of the mutated file. What is left must be listed below with its reason, and the script fails on
a missing row (`UNJUSTIFIED`) and on a row that matches no survivor (`STALE ROW`), so this file describes one commit only.

Listed: 476
Mutants: 464 (unviable 12), killed by tests 437, timeouts 15, killed by Kani 0, survivors 12

Run on 2026-11-01: 476 mutants listed, 12 unviable (they do not compile), 12 minutes for the cargo-mutants step. The Kani step killed
none of the survivors: every one is behaviourally equivalent to the original on all inputs, so no harness can fail on it. Three further
mutants (the `||` after `MAX_LEN` in `parse_digits`, the `>` of the 40 digit check, the `>` of the ASCII check) survived the first run and
were real test gaps; they are now killed by `parse_digits_refuses_39_places_and_accepts_exactly_40_digits` in `tests/decimal.rs` and
`del_is_ascii_and_a_bad_character` in `tests/keys.rs`. A survivor with no valid reason is a missing test.

A name that contains a pipe (the `|` to `^` rows) is matched by the exact text after the leading `| `, so those rows do not render as
two cells in a Markdown viewer; the script reads them as written.

| Mutant | Reason |
| --- | --- |
| src/lib.rs:19:26: replace << with >> | Equivalent: the constant is `1 << 0`, and `1 >> 0` is also 1 (bit 0, a shift by zero places). |
| src/lib.rs:28:53: replace | with ^ | Equivalent: the operands of this `|` in `TRUSTED_MASK` are disjoint single bits, so `^` gives the same mask. |
| src/lib.rs:28:44: replace | with ^ | Equivalent: the operands of this `|` in `TRUSTED_MASK` are disjoint single bits, so `^` gives the same mask. |
| src/lib.rs:28:37: replace | with ^ | Equivalent: the operands of this `|` in `TRUSTED_MASK` are disjoint single bits, so `^` gives the same mask. |
| src/lib.rs:30:49: replace | with ^ | Equivalent: the operands of this `|` in `RECIPIENT_TRUSTED` are disjoint single bits, so `^` gives the same mask. |
| src/lib.rs:30:42: replace | with ^ | Equivalent: the operands of this `|` in `RECIPIENT_TRUSTED` are disjoint single bits, so `^` gives the same mask. |
| src/decimal.rs:37:21: replace || with && in parse_digits | Equivalent: an empty text is refused by the later `int_len == 0` check, and a text over 48 bytes by the later `int_len + d > 40` and `frac_len > d` checks, so the early exit only saves work. |
| src/decimal.rs:37:32: replace > with == in parse_digits | Equivalent: a text longer than MAX_LEN (48) holds more than 40 digits, which the later `int_len + d > 40` or `frac_len > d` check refuses. |
| src/decimal.rs:37:32: replace > with >= in parse_digits | Equivalent: a text of exactly MAX_LEN (48) bytes holds at least 47 digits, and no canonical text is longer than 41 bytes, so the later checks refuse it. |
| src/decimal.rs:112:14: replace < with <= in format_digits | Equivalent: the loop only changes `lo` from `d` to `d + 1` when the units digit is `0`, and both values fail the `lo < d` test that decides whether a fraction is printed. |
| src/approve.rs:245:30: replace > with >= in amount_text_len | Equivalent: the branch clamps the places to MAX_DECIMALS (38), and at exactly 38 the clamp returns the same value. |
| src/keys.rs:91:63: replace - with + in near_account_error | Equivalent: the changed pair (j, j + 1) differs from (j - 1, j) only at the pair (0, 1), which needs a leading separator, and that is refused one line earlier. |

## Credit pool (contracts/airlock-credit): Passport mutants (AIR-333)

The credit crate is not under cargo-mutants (`scripts/mutation.sh` runs the verdict crate only); the money path mutants of AIR-328 are
listed in docs/design/credit.md. For AIR-333 each mutant below was applied alone to `src/lib.rs` and the library tests (`cargo test --lib`,
59 tests) were run on 2026-11-09; every one was killed. The rows are a list, not a table, because `scripts/mutation.sh` reads every table
row of this file as a verdict survivor.

- the cap not enforced (`open_line` without the Passport check): killed by `open_line_above_the_cap_is_refused_then_allowed_after_an_on_time_repay`, `the_record_follows_the_borrower_not_the_card`
- a dust repay counted (the 10 percent draw floor removed): killed by `dust_and_zero_fee_repays_do_not_count`
- a tiny line kept in full counted (the absolute floor `floor_base / 10` removed): killed by `ten_dust_lines_kept_in_full_do_not_raise_the_score`
- a line under 1 percent counted (the fee floor removed): killed by `ten_dust_lines_kept_in_full_do_not_raise_the_score`
- migrate drops a field (`staked` set to 0): killed by `migrate_moves_every_field_and_backfills_only_what_the_state_proves`
- the record keyed by card instead of borrower: killed by `the_record_follows_the_borrower_not_the_card`, `migrate_moves_every_field_and_backfills_only_what_the_state_proves`, `migrate_of_the_live_shape_gives_one_default_and_score_200`
- a raise of the cap base applied at once: killed by `a_lower_base_applies_at_once_a_raise_only_after_min_hold_ms`, `open_line_needs_collateral_liquidity_and_sane_terms`

Five more, applied alone on 2026-11-10 against the two rules added that day (62 tests); every one was killed:

- the draw floor taken from the base in force again (`floor_base` replaced by `passport_base` in `repay`): killed by `a_cut_of_the_base_does_not_lower_the_draw_a_repay_needs_to_count`
- a raise does not lift `floor_base`: killed by `a_cut_of_the_base_does_not_lower_the_draw_a_repay_needs_to_count`
- what the borrower holds on other cards not added to the cap: killed by `the_cap_counts_what_the_borrower_holds_on_their_other_cards`
- a new line allowed while another card of the borrower has a line past due: killed by `the_cap_counts_what_the_borrower_holds_on_their_other_cards`
- a new line allowed while another card of the borrower has an unrecovered loss: killed by `the_cap_counts_what_the_borrower_holds_on_their_other_cards`

## Credit pool (contracts/airlock-credit): Base payment check mutants (AIR-350)

Each mutant below was applied alone to `src/lib.rs` on 2026-11-10 and the library tests (`cargo test --lib`, 72 tests) were run; every
one was killed.

- a tx id in upper case accepted (`is_base_tx_id` takes any hex digit): killed by `base_check_refuses_an_id_that_is_not_64_lowercase_hex`
- the fee floor removed from `check_base_payment`: killed by `base_check_refuses_a_fee_below_the_floor_and_too_little_gas`
- the fee counted as pool money (`idle += fee` in `check_base_payment`): killed by `the_base_check_fee_cannot_move_the_share_price`
- a failed check refunds nothing: killed by `a_failed_check_records_nothing_and_refunds_the_fee`, `a_recorded_id_is_refused_and_a_late_duplicate_keeps_the_earlier_answer`, `an_unreadable_or_oversized_answer_records_nothing`
- a late duplicate overwrites the recorded answer (the callback's recorded check removed): killed by `a_recorded_id_is_refused_and_a_late_duplicate_keeps_the_earlier_answer`
- the answer read without the 2,048 byte bound: killed by `an_unreadable_or_oversized_answer_records_nothing`
- the signer asked with 0 yocto: killed by `base_check_asks_the_configured_signer_with_one_yocto`
- a failed check stores a record: killed by `a_failed_check_records_nothing_and_refunds_the_fee`, `a_recorded_id_is_refused_and_a_late_duplicate_keeps_the_earlier_answer`, `an_unreadable_or_oversized_answer_records_nothing`

## Credit pool (contracts/airlock-credit): lender storage mutants (2026-11-11)

Each mutant below was applied alone to `src/lib.rs` on 2026-11-11 and the library tests (`cargo test --lib`, 81 tests) were run; every
one was killed.

- the storage charge added to `idle` (`idle += amount + storage` in `deposit`): killed by `a_first_deposit_pays_the_storage_charge_and_a_second_is_credited_in_full`, `a_first_deposit_must_cover_the_minimum_and_the_charge`, `the_storage_charge_never_moves_the_share_price`, `property_random_operations_keep_the_accounting` and 21 earlier tests
- the charge taken from a lender who already has an entry: killed by `a_first_deposit_pays_the_storage_charge_and_a_second_is_credited_in_full`, `property_random_operations_keep_the_accounting`
- the entries not removed on a full exit (`lps` written back as 0, `locks` kept): killed by `a_full_withdraw_removes_both_entries_and_a_partial_keeps_them`, `a_failed_withdraw_transfer_after_a_full_exit_gives_the_shares_back`, `the_views_answer_a_missing_entry_like_a_zero_entry`, `the_charge_covers_the_storage_of_the_longest_lender`, `property_random_operations_keep_the_accounting`
- the `MAX_CARDS` check in `on_card_roles` removed: killed by `the_callback_checks_max_cards_again`

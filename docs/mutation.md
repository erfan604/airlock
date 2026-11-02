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

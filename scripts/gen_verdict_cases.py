#!/usr/bin/env python3
"""AIR-023: verdict cases for the Lean versus Rust differential test, one case per line, 21 natural numbers in the column order of
proofs/VerdictRun.lean:
  amount fee_kind fee gas_kind gas recipient amount_labels pc asset_kind hard_cap remaining_daily max_fee max_gas
  payee_kind cap_kind cap budget limit task_kind remaining paused
A `*_kind` of 1 means the paired value is `some`, 0 means `none` (the paired value is then ignored). The three label columns are u16 masks
that use bits 0 to 14 (bit 15 is invalid on the wire and is never generated). Every value is below 2^128.
Usage: gen_verdict_cases.py N SEED MODE      MODE is one of
  uniform   random values as in the spike: small numbers around 1000, labels 40 percent trusted (most lines end at rules 0 to 2)
  boundary  amounts and limits at limit minus 1, equal, plus 1, zero, 2^53 plus or minus 1, u128::MAX minus 1 and equal, the limits
            themselves also at u128::MAX; label sets and kinds are biased so that the deeper rules decide many lines
  toggle    the base line (an Allow), then one line per rule flip (22 lines in all, C1 to C17d of proofs/Verdict.lean allow_iff), then
            random multi-flips of the base that touch different columns
Exit 2 with a usage line on bad arguments. The output depends only on N, SEED and MODE."""
import random
import sys

U128_MAX = (1 << 128) - 1
COLS = ("amount fee_kind fee gas_kind gas recipient amount_labels pc asset_kind hard_cap remaining_daily max_fee max_gas "
        "payee_kind cap_kind cap budget limit task_kind remaining paused").split()
IDX = {name: i for i, name in enumerate(COLS)}
MASK_BELOW = 1 << 15  # label masks use bits 0 to 14

# satisfies every one of the 17 conditions of allow_iff: an untrusted (email) amount of 100 inside the payee cap and budget of 500
BASE = [100, 1, 10, 1, 21000, 2, 32, 1, 1, 1000, 1000, 50, 100000, 1, 1, 500, 500, 1000, 1, 1000, 0]

# one flip per condition, in the order of the ticket; each changes only the named columns of the base
FLIPS = [
    ("C1", {"asset_kind": 0}),
    ("C2", {"paused": 1}),
    ("C3", {"amount": 0}),
    ("C4", {"hard_cap": 99}),
    ("C5", {"remaining_daily": 99}),
    ("C6", {"fee": 51}),
    ("C7", {"gas": 100001}),
    ("C8", {"recipient": 0}),
    ("C9", {"amount_labels": 0}),
    ("C10", {"pc": 0}),
    ("C11", {"task_kind": 0}),
    ("C12", {"remaining": 99}),
    ("C13", {"pc": 33}),
    ("C14", {"recipient": 34}),
    ("C15", {"payee_kind": 0}),
    ("C15b", {"payee_kind": 0, "recipient": 1}),  # a Book recipient with no payee blocks, so NewRecipient needs an Owner recipient
    ("C16", {"limit": 99}),
    ("C17a", {"cap_kind": 0}),
    ("C17b", {"cap": 99}),
    ("C17c", {"amount_labels": 16}),
    ("C17d", {"budget": 99}),
]

# the amounts the boundary mode likes
EDGE_AMOUNTS = [0, 1, 2, (1 << 53) - 1, 1 << 53, (1 << 53) + 1, U128_MAX - 1, U128_MAX]


def labels(rng, p_trusted):
    """a label mask: empty 8 percent of the time, else trusted (Owner, Book, Policy, Oracle and mixes) or tainted"""
    if rng.random() < 0.08:
        return 0
    if rng.random() < p_trusted:
        return rng.choice([1, 2, 4, 8, 3, 10, 2 | 8, 1 | 4])
    return rng.choice([16, 32, 64, 1 | 32, 2 | 64, 2 | 16, 1 | 16, rng.randint(1, MASK_BELOW - 1)])


def small(rng):
    return rng.choice([0, 1, 2, 5, 10, 50, 100, 499, 500, 501, 1000, 1001, rng.randint(0, 2000)])


def uniform_row(rng):
    return [small(rng), rng.randint(0, 1), small(rng), rng.randint(0, 1), small(rng), labels(rng, 0.4), labels(rng, 0.4),
            labels(rng, 0.4), rng.randint(0, 1), small(rng), small(rng), small(rng), small(rng), rng.randint(0, 1),
            rng.randint(0, 1), small(rng), small(rng), small(rng), rng.randint(0, 1), small(rng), int(rng.random() < 0.1)]


def near(rng, a):
    """a value at the edge of `a`: a minus 1, a, a plus 1 (all kept inside u128), the maximum, or a random small one"""
    x = rng.random()
    if x < 0.14:
        return max(0, a - 1)
    if x < 0.40:
        return a
    if x < 0.64:
        return min(U128_MAX, a + 1)
    if x < 0.90:
        return U128_MAX
    return rng.randint(0, 2000)


def near_cap(rng, cap):
    """a fee or gas value just under, at or just over its cap: mostly passing, so the rules after rule 3 are reached"""
    x = rng.random()
    if x < 0.35:
        return max(0, cap - 1)
    if x < 0.85:
        return cap
    return cap + 1


def boundary_row(rng):
    amount = rng.choice(EDGE_AMOUNTS) if rng.random() < 0.45 else rng.randint(1, 1500)
    max_fee = rng.randint(20, 100)
    max_gas = rng.randint(21000, 200000)
    return [amount,
            int(rng.random() < 0.4), near_cap(rng, max_fee), int(rng.random() < 0.4), near_cap(rng, max_gas),
            labels(rng, 0.75), labels(rng, 0.6), labels(rng, 0.8),
            int(rng.random() < 0.97), near(rng, amount), near(rng, amount), max_fee, max_gas,
            int(rng.random() < 0.88), int(rng.random() < 0.8), near(rng, amount), near(rng, amount), near(rng, amount),
            int(rng.random() < 0.93), near(rng, amount), int(rng.random() < 0.03)]


def flipped(names):
    row = list(BASE)
    for name in names:
        for column, value in dict(FLIPS)[name].items():
            row[IDX[column]] = value
    return row


def multi_flip_row(rng):
    """two to four flips of the base that touch different columns, so no flip hides another"""
    wanted = rng.choice([2, 2, 3, 4])
    order = [name for name, _ in FLIPS]
    rng.shuffle(order)
    chosen, touched = [], set()
    for name in order:
        columns = set(dict(FLIPS)[name])
        if columns & touched:
            continue
        chosen.append(name)
        touched |= columns
        if len(chosen) == wanted:
            break
    return flipped(chosen)


def toggle_rows(rng, n):
    block = [list(BASE)] + [flipped([name]) for name, _ in FLIPS]
    rows = block[:n]
    while len(rows) < n:
        rows.append(multi_flip_row(rng))
    return rows


def rows_for(n, seed, mode):
    rng = random.Random(seed)
    if mode == "toggle":
        return toggle_rows(rng, n)
    make = uniform_row if mode == "uniform" else boundary_row
    return [make(rng) for _ in range(n)]


def main(argv):
    usage = "usage: gen_verdict_cases.py N SEED MODE   (MODE: uniform, boundary or toggle)"
    if len(argv) != 3 or argv[2] not in ("uniform", "boundary", "toggle") or not argv[0].isdigit() or not argv[1].isdigit():
        print(usage, file=sys.stderr)
        return 2
    for row in rows_for(int(argv[0]), int(argv[1]), argv[2]):
        if len(row) != 21 or any(not 0 <= v < (1 << 128) for v in row):
            raise AssertionError(f"bad row {row}")
        print(*row)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""AIR-023: tests of scripts/gen_verdict_cases.py. Every test runs the script through subprocess (it is never imported, so the test
needs no sys.path change) and asserts on the printed lines. Run: python3 -m unittest -v scripts/test_gen_verdict_cases.py"""
import subprocess
import sys
import unittest
from pathlib import Path

GEN = Path(__file__).resolve().parent / "gen_verdict_cases.py"
COLS = ("amount fee_kind fee gas_kind gas recipient amount_labels pc asset_kind hard_cap remaining_daily max_fee max_gas "
        "payee_kind cap_kind cap budget limit task_kind remaining paused").split()
KINDS = [1, 3, 8, 13, 14, 18, 20]
LABELS = [5, 6, 7]
U128 = 1 << 128
BASE = "100 1 10 1 21000 2 32 1 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0"
TOGGLE_BLOCK = [
    BASE,
    "100 1 10 1 21000 2 32 1 0 1000 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C1 asset_kind=0
    "100 1 10 1 21000 2 32 1 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 1",  # C2 paused=1
    "0 1 10 1 21000 2 32 1 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C3 amount=0
    "100 1 10 1 21000 2 32 1 1 99 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C4 hard_cap=99
    "100 1 10 1 21000 2 32 1 1 1000 99 50 100000 1 1 500 500 1000 1 1000 0",  # C5 remaining_daily=99
    "100 1 51 1 21000 2 32 1 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C6 fee=51
    "100 1 10 1 100001 2 32 1 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C7 gas=100001
    "100 1 10 1 21000 0 32 1 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C8 recipient=0
    "100 1 10 1 21000 2 0 1 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C9 amount_labels=0
    "100 1 10 1 21000 2 32 0 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C10 pc=0
    "100 1 10 1 21000 2 32 1 1 1000 1000 50 100000 1 1 500 500 1000 0 1000 0",  # C11 task_kind=0
    "100 1 10 1 21000 2 32 1 1 1000 1000 50 100000 1 1 500 500 1000 1 99 0",  # C12 remaining=99
    "100 1 10 1 21000 2 32 33 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C13 pc=33
    "100 1 10 1 21000 34 32 1 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C14 recipient=34
    "100 1 10 1 21000 2 32 1 1 1000 1000 50 100000 0 1 500 500 1000 1 1000 0",  # C15 payee_kind=0
    "100 1 10 1 21000 1 32 1 1 1000 1000 50 100000 0 1 500 500 1000 1 1000 0",  # C15b payee_kind=0, recipient=1
    "100 1 10 1 21000 2 32 1 1 1000 1000 50 100000 1 1 500 500 99 1 1000 0",  # C16 limit=99
    "100 1 10 1 21000 2 32 1 1 1000 1000 50 100000 1 0 500 500 1000 1 1000 0",  # C17a cap_kind=0
    "100 1 10 1 21000 2 32 1 1 1000 1000 50 100000 1 1 99 500 1000 1 1000 0",  # C17b cap=99
    "100 1 10 1 21000 2 16 1 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0",  # C17c amount_labels=16
    "100 1 10 1 21000 2 32 1 1 1000 1000 50 100000 1 1 500 99 1000 1 1000 0",  # C17d budget=99
]


def gen(n, seed, mode):
    """the printed lines of `gen_verdict_cases.py N SEED MODE`; a non-zero exit fails the test"""
    p = subprocess.run([sys.executable, str(GEN), str(n), str(seed), mode], capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    return p.stdout.splitlines()


def rows(lines):
    return [[int(t) for t in line.split(" ")] for line in lines]


def is_boundary(r):
    """a line whose amount sits on an edge: zero, 2^53 plus or minus 1, u128::MAX or one below, or within 1 of a limit column"""
    amount, limits = r[0], [r[9], r[10], r[15], r[16], r[17], r[19]]
    edges = {0, (1 << 53) - 1, 1 << 53, (1 << 53) + 1, U128 - 2, U128 - 1}
    return amount in edges or any(abs(amount - v) <= 1 for v in limits)


class GenVerdictCases(unittest.TestCase):
    def test_line_shape_21_columns_in_every_mode(self):
        for mode in ("uniform", "boundary", "toggle"):
            lines = gen(300, 5, mode)
            self.assertEqual(len(lines), 300, mode)
            for line in lines:
                self.assertRegex(line, r"^[0-9]+( [0-9]+){20}$", mode)
                r = [int(t) for t in line.split(" ")]
                for i in KINDS:
                    self.assertIn(r[i], (0, 1), f"{mode} column {COLS[i]}")

    def test_deterministic_per_seed_and_different_across_seeds(self):
        for mode in ("uniform", "boundary", "toggle"):
            self.assertEqual(gen(200, 7, mode), gen(200, 7, mode), mode)
            self.assertNotEqual(gen(200, 7, mode), gen(200, 8, mode), mode)

    def test_boundary_share_is_at_least_30_percent_and_above_uniform(self):
        boundary = [is_boundary(r) for r in rows(gen(2000, 11, "boundary"))]
        uniform = [is_boundary(r) for r in rows(gen(2000, 11, "uniform"))]
        self.assertGreaterEqual(sum(boundary) / len(boundary), 0.30)
        # the uniform mode also lands on edges by chance (its small numbers repeat 0, 1, 500 and 1000), so only an ordering holds
        self.assertGreater(sum(boundary), sum(uniform))

    def test_toggle_block_is_the_base_and_21_single_flips_in_order(self):
        lines = gen(400, 13, "toggle")
        self.assertEqual(lines[:22], TOGGLE_BLOCK)
        self.assertEqual(len(set(lines[:22])), 22)

    def test_toggle_rest_is_multi_flips_of_the_base(self):
        base = [int(t) for t in BASE.split(" ")]
        for r in rows(gen(400, 13, "toggle")[22:]):
            self.assertGreaterEqual(sum(1 for a, b in zip(r, base) if a != b), 2)

    def test_toggle_shorter_than_the_block_is_a_prefix(self):
        self.assertEqual(gen(5, 1, "toggle"), TOGGLE_BLOCK[:5])
        self.assertEqual(gen(0, 1, "toggle"), [])

    def test_label_masks_stay_below_2_to_the_15(self):
        for mode in ("uniform", "boundary", "toggle"):
            for r in rows(gen(2000, 3, mode)):
                for i in LABELS:
                    self.assertLess(r[i], 1 << 15, f"{mode} column {COLS[i]}")

    def test_every_value_is_below_2_to_the_128(self):
        seen_max = False
        for mode in ("uniform", "boundary", "toggle"):
            for r in rows(gen(2000, 9, mode)):
                for v in r:
                    self.assertLess(v, U128, mode)
                    seen_max = seen_max or v >= U128 - 1
        self.assertTrue(seen_max, "the boundary mode never reached u128::MAX minus 1")

    def test_bad_usage_exits_2(self):
        for argv in ([], ["10", "1"], ["10", "1", "deep"], ["x", "1", "uniform"], ["10", "y", "uniform"], ["-1", "1", "uniform"]):
            p = subprocess.run([sys.executable, str(GEN), *argv], capture_output=True, text=True)
            self.assertEqual(p.returncode, 2, argv)
            self.assertEqual(p.stdout, "", argv)


if __name__ == "__main__":
    unittest.main()

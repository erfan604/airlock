#!/usr/bin/env python3
"""AIR-023: counts per outcome tag in a Rust tag file (the output of contracts/airlock-verdict/examples/diff.rs, one tag per line) and
prints a table, so a differential run shows that every outcome was exercised.
Usage: diff-report.py FILE [--commit-check] [--toggle-check]
  --commit-check  fails (exit 1) if any of the 15 tags (allow plus the 14 reasons verdict returns) has count 0 or a line is not one of
                  them; otherwise the last line is `TAGS OK (15 of 15)`
  --toggle-check  FILE is target/diff.toggle.rust: its first 22 lines are the toggle block of scripts/gen_verdict_cases.py (the base, an
                  allow, then 21 single flips that must not allow, each with the tag the rules give it); prints a line per flip and
                  ends with `TOGGLE OK (22 lines, 21 flips, 0 allow)`; exits 1 otherwise
Exit 2 on bad usage or an unreadable file. python3 3.8 or later, standard library only."""
import sys

BLOCK = ["UnknownAsset", "Paused", "AmountOutOfBounds", "DailyLimit", "FeeTooHigh", "MissingProvenance", "BookLabelNotInBook"]
ESCALATE = ["OutsideTask", "OverTaskBound", "UntrustedTrigger", "UntrustedRecipient", "NewRecipient", "OverPayeeLimit", "UntrustedAmount"]
TAGS = ["allow"] + [f"block:{r}" for r in BLOCK] + [f"escalate:{r}" for r in ESCALATE]

# the tag of each of the 22 toggle lines: the base, then the flips C1 to C17d in order (the tags of the rules in SPEC 8.3)
TOGGLE = [
    ("base", "allow"), ("C1", "block:UnknownAsset"), ("C2", "block:Paused"), ("C3", "block:AmountOutOfBounds"),
    ("C4", "block:AmountOutOfBounds"), ("C5", "block:DailyLimit"), ("C6", "block:FeeTooHigh"), ("C7", "block:FeeTooHigh"),
    ("C8", "block:MissingProvenance"), ("C9", "block:MissingProvenance"), ("C10", "block:MissingProvenance"),
    ("C11", "escalate:OutsideTask"), ("C12", "escalate:OverTaskBound"), ("C13", "escalate:UntrustedTrigger"),
    ("C14", "escalate:UntrustedRecipient"), ("C15", "block:BookLabelNotInBook"), ("C15b", "escalate:NewRecipient"),
    ("C16", "escalate:OverPayeeLimit"), ("C17a", "escalate:UntrustedAmount"), ("C17b", "escalate:UntrustedAmount"),
    ("C17c", "escalate:UntrustedAmount"), ("C17d", "escalate:UntrustedAmount"),
]


def read_tags(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().splitlines()
    except OSError as e:
        print(f"diff-report: cannot read {path}: {e.strerror}", file=sys.stderr)
        sys.exit(2)


def table(tags):
    counts = {}
    for t in tags:
        counts[t] = counts.get(t, 0) + 1
    total = len(tags)
    print(f"{'tag':<34} {'count':>8} {'share':>7}")
    for t in TAGS + sorted(set(counts) - set(TAGS)):
        n = counts.get(t, 0)
        share = f"{100 * n / total:.2f}%" if total else "0.00%"
        print(f"{t:<34} {n:>8} {share:>7}")
    print(f"{'total':<34} {total:>8}")
    return counts


def commit_check(counts):
    missing = [t for t in TAGS if counts.get(t, 0) == 0]
    unknown = sorted(set(counts) - set(TAGS))
    if missing or unknown:
        for t in missing:
            print(f"MISSING: {t} has count 0")
        for t in unknown:
            print(f"UNKNOWN: {t!r} is not an outcome tag ({counts[t]} lines)")
        print(f"TAGS FAILED ({len(TAGS) - len(missing)} of {len(TAGS)})")
        return 1
    print(f"TAGS OK ({len(TAGS)} of {len(TAGS)})")
    return 0


def toggle_check(tags):
    if len(tags) < len(TOGGLE):
        print(f"TOGGLE FAILED ({len(tags)} lines, want at least {len(TOGGLE)})")
        return 1
    bad = 0
    for i, (name, want) in enumerate(TOGGLE):
        got = tags[i]
        mark = "" if got == want else f"   WANT {want}"
        print(f"{name:<5} {got}{mark}")
        if got != want:
            bad += 1
    allows = sum(1 for t in tags[1:len(TOGGLE)] if t == "allow")
    if tags[0] != "allow" or allows != 0 or bad:
        print(f"TOGGLE FAILED (first line {tags[0]!r}, {allows} flips allowed, {bad} lines differ from the rules)")
        return 1
    print(f"TOGGLE OK ({len(TOGGLE)} lines, {len(TOGGLE) - 1} flips, {allows} allow)")
    return 0


def main(argv):
    flags = [a for a in argv[1:] if a.startswith("--")]
    files = [a for a in argv[1:] if not a.startswith("--")]
    if len(files) != 1 or any(f not in ("--commit-check", "--toggle-check") for f in flags):
        print("usage: diff-report.py FILE [--commit-check] [--toggle-check]", file=sys.stderr)
        return 2
    tags = read_tags(files[0])
    code = 0
    if "--toggle-check" not in flags or "--commit-check" in flags:
        counts = table(tags)
        if "--commit-check" in flags:
            code |= commit_check(counts)
    if "--toggle-check" in flags:
        code |= toggle_check(tags)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))

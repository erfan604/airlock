#!/usr/bin/env python3
"""Measured velocity and the checkpoint decision (plan/BUILD_PLAN.md, "Checkpoint rule from the reviewed estimates").

Usage: python3 scripts/velocity.py [--dir plan/tickets] [--factor 1.5] [--checkpoint [--band 0.05] [--from YYYY-MM-DD]]
Reads every ticket with status done and an actual_h (written by scripts/clock.py stop). s = sum(actual_h) / sum(estimate),
where an estimate of a ticket without `reviewed:` is multiplied by --factor, the same rule schedule.py uses. Prints s overall,
per gate and for the last five tickets done (the trend matters: the G1 tickets are the best specified, so an early s is
optimistic). With --checkpoint it finds, for every s from the measured one up to s + band in steps of 0.01, the shortest
prefix of the ordered drops (D2, D3, D10, D4, D5, D6, D1) that places every critical ticket in both schedule.py and lanes.py, and applies the worst
of them. The band is there because the early s is optimistic and because list scheduling is not monotonic near the edge
(2026-10-22: s = 0.99 exhausted the ladder while s = 1.00 needed only D1 to D3). Standard library only.
"""
import argparse, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import schedule as S  # noqa: E402  (WINDOW, default_start)
# the drop order decided 2026-10-22 (BUILD_PLAN): D2 the AB claim tests, D3 live trace becomes replayed, D10 the live demo
# footage (plan/TAIL_PROPOSAL_2026-10-22.md: polish, not a claim), D4 rung 9 early (the live demo pays on the NEAR lane), D5
# BENCH doc folds into the README, D6 rung 7 (CLI approve, no wallet), and last D1 the Lean axiom audit: moved from first to
# last the same evening after two judges (Illia, Haseeb Qureshi) posted about formal verification; it is 1.5 h and the move
# left the robust range unchanged (within the ladder up to s = 0.98; notes/intel_2026-10-22.md)
DROPS = [("D2", ["AIR-084", "AIR-108"], "approval-surface tests AB1 to AB12 and I1/I5; C8 keeps the tamper row"),
         ("D3", ["AIR-184"], "live trace view becomes a replayed trace (rung 4)"),
         ("D10", ["AIR-247"], "shot S04 comes from the replay demo with recorded captions; pnpm demo:live is cut (also by hand: AIR-249 "
                              "loses 0.6 h, PRD FR-18 one-line edit)"),
         ("D4", ["AIR-162"], "rung 9 early: EVM lane sandbox-proven with the recorded MPC signature, live demo on NEAR"),
         ("D5", ["AIR-244"], "BENCH methodology folds into the README bench section"),
         ("D6", ["AIR-182"], "rung 7: wallet approve becomes the CLI approve with the same card data"),
         ("D1", ["AIR-030"], "Lean axiom audit wrapper; C1a cites core lake check")]


def front(path):
    text = open(path, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    out = {}
    for line in (m.group(1) if m else "").splitlines():
        line = line.split("#", 1)[0].rstrip()
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def load(d):
    T = {}
    for n in sorted(os.listdir(d)):
        if re.match(r"AIR-\d{3}.*\.md$", n):
            f = front(os.path.join(d, n))
            if f.get("id"):
                T[f["id"]] = f
    return T


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def critical_unplaced(d, factor, scale, drops, start=None):
    """Critical tickets that do not fit, in either model: schedule.py pools each day's hours, lanes.py runs real lanes where a
    serial chain cannot use a second lane. The lane model is the stricter one (2026-10-22: it left five G5 tickets out while
    the pooled model placed them), so the decision takes the union."""
    args = ["--dir", d, "--factor", str(factor), "--scale", f"{scale:.3f}"] + (["--drop=" + ",".join(drops)] if drops else [])
    when = [start] if start else []
    out = subprocess.run([sys.executable, os.path.join(HERE, "schedule.py"), *args, *(["--start"] + when if when else [])],
                         capture_output=True, text=True).stdout
    T = load(d)
    crit = {k for k, v in T.items() if v.get("critical") == "true"}
    left = {l.split()[1] for l in out.splitlines() if "LATE" in l and l.rstrip().endswith("unplaced") and l.split()[1] in crit}
    r = subprocess.run([sys.executable, os.path.join(HERE, "lanes.py"), *args, "--days", "0", *(["--from"] + when if when else [])],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("lanes.py failed: " + r.stderr.strip())
    for l in r.stdout.splitlines():
        if l.startswith("Critical tickets that do not fit:"):
            left |= set(l.split(":", 1)[1].split())
    return sorted(left)


def names(i):
    return ", ".join(n for n, _, _ in DROPS[:i])


def prefix_needed(d, factor, s, start=None):
    """0 when every critical ticket places with no drops, i when the first i drops of DROPS are needed, len(DROPS) + 1 when the whole ladder is
    not enough (with the critical tickets still out)."""
    chosen, left = [], critical_unplaced(d, factor, s, [], start)
    if not left:
        return 0, []
    for i, (_, ids, _) in enumerate(DROPS, 1):
        chosen += ids
        left = critical_unplaced(d, factor, s, chosen, start)
        if not left:
            return i, []
    return len(DROPS) + 1, left


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="plan/tickets")
    ap.add_argument("--factor", type=float, default=1.5)
    ap.add_argument("--checkpoint", action="store_true")
    ap.add_argument("--band", type=float, default=0.05, help="also decide for s up to s + band and take the worst")
    # checkpoints run in the evening, so today's capacity is spent: plan the remaining work from tomorrow
    ap.add_argument("--from", dest="start", default=None, help="first day with unspent capacity (default tomorrow, from 2026-10-28)")
    a = ap.parse_args()
    T = load(a.dir)
    done = []
    for k, v in T.items():
        act, est = num(v.get("actual_h")), num(v.get("estimate_h"))
        if v.get("status") == "done" and act is not None and est:
            eff = est if v.get("reviewed") else est * a.factor
            done.append((v.get("stopped", ""), k, v.get("gate", "?"), eff, act))
    missing = [k for k, v in T.items() if v.get("status") == "done" and num(v.get("actual_h")) is None]
    if not done:
        print("no done tickets with actual_h yet (scripts/clock.py start and stop record them)")
        if missing:
            print("done without actual_h:", ", ".join(sorted(missing)))
        return 0
    done.sort()
    E, A = sum(x[3] for x in done), sum(x[4] for x in done)
    s = A / E
    print(f"{len(done)} tickets done: {A:.1f} h actual against {E:.1f} h estimated, s = {s:.2f}")
    gates = {}
    for _, _, g, e, act in done:
        ge = gates.setdefault(g, [0.0, 0.0, 0]); ge[0] += e; ge[1] += act; ge[2] += 1
    for g, (e, act, n) in gates.items():
        print(f"  {g:7s} {n:3d} done  s = {act / e:.2f}")
    last = done[-5:]
    print(f"  last {len(last)}: s = {sum(x[4] for x in last) / sum(x[3] for x in last):.2f}")
    if missing:
        print("done without actual_h (left out):", ", ".join(sorted(missing)))
    if not a.checkpoint:
        return 0
    start = a.start or S.default_start(1)
    print(f"\ncheckpoint at s = {s:.2f} (factor {a.factor} for unreviewed tickets), remaining work planned from {start}")
    if s <= 0.85:
        print("s at or below 0.85: admit Should items in BUILD_PLAN order as schedule.py places them")
    # TEE lane (REVIEW_coldstart_2026-10-22_tee.md): the full lane places by Nov 9 only at s <= 0.65, TEE-lite (AIR-200 alone,
    # tested on the recorded real quote) at s <= 0.75; otherwise G4 is OUT and the README says "local mode, unattested"
    print("TEE lane: " + ("IN, full lane" if s <= 0.65 else "TEE-lite only (AIR-200 on the recorded real quote)" if s <= 0.75 else "OUT at G4: local mode, unattested"))
    need = {}
    for p in [round(s + k * 0.01, 2) for k in range(int(round(a.band / 0.01)) + 1)]:
        i, left = need[p] = prefix_needed(a.dir, a.factor, p, start)
        print(f"  s = {p:.2f}: " + ("no drops" if i == 0 else names(i) if i <= len(DROPS) else "ladder exhausted, still out: " + " ".join(left)))
    worst = max(i for i, _ in need.values())
    if worst == 0:
        print("every critical ticket places with no drops across the band")
        return 0
    if worst > len(DROPS):
        print("the ladder is exhausted inside the band: re-plan the bench scope at this checkpoint (BUILD_PLAN)")
        return 1
    for name, ids, what in DROPS[:worst]:
        print(f"  {name} ({', '.join(ids)}): {what}")
    print(f"decision: apply {names(worst)} as written in BUILD_PLAN")
    return 0


if __name__ == "__main__":
    sys.exit(main())

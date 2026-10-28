#!/usr/bin/env python3
"""Explicit lane plan for dispatching build agents: which ticket each lane works, in order, day by day.

Usage: python3 scripts/lanes.py [--dir plan/tickets] [--factor 1.5] [--scale 1.0] [--lane-hours 8] [--from 2026-10-28] [--days 3]
                                [--drop AIR-x,AIR-y]   (what-if: those tickets are cut and never block their dependents)
Each day gets ceil(capacity / lane hours) lanes sharing the capacity evenly (the 4 and 5 lane days of capacity.json). List scheduling with real lanes: a
ticket starts on the lane that frees first, after all its dependencies have finished (on any lane), and runs across days
when it is longer than what is left of the lane's day. Priority is the scheduler's: critical path first, then gate date,
then tier, then most dependents. Tickets that run at the same time on different lanes and name the same file in their
Scope are flagged, so two agents never edit one file at once. Standard library only; reads the same capacity.json.
"""
import argparse, json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import schedule as S  # noqa: E402  (load(), GATE_DUE, TIER)

# the guard's protected control files (.claude/hooks/guard_bash.py PROTECTED): editing one always prompts the human, so a lane
# working such a ticket stalls until Erfan answers; the plan marks them so they run while he is at the keyboard
GATED_RE = re.compile(r"(scripts/hooks/|scripts/check\.sh|scripts/check-commits\.sh|\.claude/settings|\.claude/hooks/|\.github/workflows/)")
PATH_RE = re.compile(r"((?:[\w.-]+/)+[\w.-]+\.(?:jsonl|json|tsx|ts|mjs|js|rs|lean|py|sh|toml|md|css|html))(?![\w.])")


def scope_files(d, fname):
    text = open(os.path.join(d, fname), encoding="utf-8").read()
    m = re.search(r"## Scope\n(.*?)(?:\n## |\Z)", text, re.S)
    return set(PATH_RE.findall(m.group(1))) if m else set()


# create, write, update, modify and change were missing until 2026-10-24: AIR-203 creates a workflow file and was not flagged
EDIT_RE = re.compile(r"\b(add|adds|append|appends|edit|edits|rewrite|rewrites|remove|removes|replace|delete|insert|create|creates|write|writes|update|updates|modify|modifies|change|changes)\b", re.I)


def gated(d, fname):
    """Protected paths the ticket edits: a Scope sentence names the path together with an edit verb. A sentence that only runs
    it (`scripts/check.sh full` is green), hands the edit to another ticket ("stays with AIR-240") or says the line is already in
    the kit ("pre-wired", D14) does not count."""
    text = open(os.path.join(d, fname), encoding="utf-8").read()
    m = re.search(r"## Scope\n(.*?)(?:\n## |\Z)", text, re.S)
    hits = set()
    scope = m.group(1) if m else ""
    for sent in re.split(r"(?<=[.;])\s+", scope):
        if EDIT_RE.search(sent) and "stays with" not in sent and "pre-wired" not in sent:
            hits |= set(GATED_RE.findall(sent))
    for line in scope.splitlines():                  # a bullet that opens with a protected path specifies that file's content
        b = re.match(r"\s*[-*]\s+`([^`]+)`", line)    # (AIR-203: "- `.github/workflows/image.yml`: on: workflow_dispatch ...")
        if b and "stays with" not in line and "pre-wired" not in line:
            hits |= set(GATED_RE.findall(b.group(1)))
    return sorted(hits)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="plan/tickets")
    ap.add_argument("--factor", type=float, default=1.5)
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--lane-hours", type=float, default=8.0)
    ap.add_argument("--from", dest="start", default=S.default_start(), help="first day with unspent capacity (default today, from 2026-10-28)")
    ap.add_argument("--days", type=int, default=3, help="days to print (the plan is computed for the whole window)")
    ap.add_argument("--drop", default="", help="comma-separated ticket ids to treat as cut for a what-if")
    a = ap.parse_args()
    T = S.load(a.dir)
    dropped = {x.strip() for x in a.drop.split(",") if x.strip()}
    if dropped - set(T):
        sys.exit(f"--drop: unknown ticket ids {', '.join(sorted(dropped - set(T)))}")
    for v in T.values():
        if not v["reviewed"]:
            v["est"] *= a.factor
        v["est"] *= a.scale
    cap = {k: float(v) for k, v in json.load(open(os.path.join(a.dir, "capacity.json"))).items() if not k.startswith("_")}
    days = sorted(k for k in cap if k >= a.start and cap[k] > 0)
    L = a.lane_hours
    children = {k: [j for j in T if k in T[j]["deps"]] for k in T}
    memo = {}
    def reach(k):
        if k not in memo:
            s = set()
            for c in children[k]:
                s.add(c); s |= reach(c)
            memo[k] = s
        return memo[k]
    crit = set()
    def mark(k):
        if k in crit or k not in T: return
        crit.add(k)
        for d in T[k]["deps"]: mark(d)
    for k, v in T.items():
        if v["critical"]: mark(k)
    # unfinished tickets dated before --from are still work; only prep tickets (schedule.is_prep) are left out
    fixed = {k for k, v in T.items() if v["owner"] == "erfan" or v["status"] in ("done", "cut") or S.is_prep(v)} | dropped
    # Day by day. Each day has N lanes of capacity/N hours. Work left over from yesterday continues first (on any lane, the
    # way an agent picks up its ticket next morning); then whenever a lane frees, it takes the most urgent ticket whose
    # dependencies finished earlier that day or before; a lane idles only when nothing is ready until another lane finishes.
    lanes_on = {i: max(1, math.ceil(cap[d] / L - 1e-9)) for i, d in enumerate(days)}
    prio = lambda k: (k not in crit, S.GATE_DUE.get(T[k]["gate"], "2099"), S.TIER.get(T[k]["tier"], 3), -len(reach(k)), k)
    finish = {k: (-1, 0.0) for k in fixed}
    runs = []                                             # (ticket, lane, (day, start), (day, end)) one per day segment
    todo, carry = [k for k in T if k not in fixed], {}    # carry: ticket -> hours left
    for i, d in enumerate(days):
        H, N = cap[d] / lanes_on[i], lanes_on[i]
        off, cur = [0.0] * N, [None] * N
        for l, k in enumerate(sorted(carry, key=prio)[:N]):          # yesterday's tickets first
            run = min(carry[k], H)
            runs.append((k, l, (i, 0.0), (i, run))); off[l] = run
            carry[k] -= run
            if carry[k] <= 1e-9: finish[k] = (i, run); del carry[k]
            else: cur[l] = k
        while True:
            free = [l for l in range(N) if off[l] < H - 1e-9 and cur[l] is None]
            if not free: break
            l = min(free, key=lambda x: off[x])
            parked = [k for k in carry if k not in cur]     # carried in but left without a lane this morning (fewer lanes today)
            if parked:                                       # a freed lane resumes it before starting anything new
                k = min(parked, key=prio); run = min(carry[k], H - off[l])
                runs.append((k, l, (i, off[l]), (i, off[l] + run))); off[l] += run; carry[k] -= run
                if carry[k] <= 1e-9: finish[k] = (i, off[l]); del carry[k]
                else: cur[l] = k
                continue
            ready = [k for k in todo if all((dd not in T) or (dd in finish and finish[dd] <= (i, off[l])) for dd in T[k]["deps"])]
            if not ready:
                later = sorted(e[1] for k2, e in finish.items() if e[0] == i and e[1] > off[l])
                if later: off[l] = later[0]
                else: off[l] = H
                continue
            k = min(ready, key=prio); todo.remove(k)
            run = min(T[k]["est"], H - off[l])
            runs.append((k, l, (i, off[l]), (i, off[l] + run)))
            off[l] += run
            if T[k]["est"] - run <= 1e-9: finish[k] = (i, off[l])
            else: carry[k] = T[k]["est"] - run; cur[l] = k
    unplaced = sorted(todo + list(carry))
    used = sum(r[3][1] - r[2][1] for r in runs); total = sum(cap[d] for d in days)
    files = {k: scope_files(a.dir, T[k]["file"]) for k, _, _, _ in runs}
    gate = {k: g for k in files if (g := gated(a.dir, T[k]["file"]))}
    clashes = []
    for i, (k1, l1, s1, e1) in enumerate(runs):
        for k2, l2, s2, e2 in runs[i + 1:]:
            if l1 != l2 and s1 < e2 and s2 < e1:
                both = files[k1] & files[k2]
                if both: clashes.append((k1, k2, sorted(both)))
    show = days[:a.days]
    for i, d in enumerate(show):
        print(f"\n{d}  ({cap[d]:.0f} h, {lanes_on[i]} lanes of {cap[d] / lanes_on[i]:.1f} h)")
        for l in range(lanes_on[i]):
            seg = sorted((r for r in runs if r[1] == l and r[2][0] == i), key=lambda r: r[2][1])
            parts = []
            for k, _, st, en in seg:
                cont = any(r[0] == k and r[2][0] < i for r in runs)
                more = finish.get(k, (99, 0))[0] > i or k in carry
                parts.append(f"{k} {en[1] - st[1]:.1f}h{'*' if k in crit else ''}{'!' if k in gate else ''}{' (cont.)' if cont else ''}{' ->' if more else ''}")
            print(f"  lane {l + 1}: " + (" | ".join(parts) or "idle"))
        today = sorted({r[0] for r in runs if r[2][0] == i and r[0] in gate})
        if today:
            print("  ! needs Erfan at the keyboard (protected file prompt): " + ", ".join(f"{k} ({', '.join(gate[k])})" for k in today))
    end_crit = max((finish[k] for k in crit if k in finish and k not in fixed), default=None)
    crit_out = [k for k in unplaced if k in crit]
    print("\n* critical path. ! edits a protected file, so the lane stops at a human prompt.",
          f"Last {'placed ' if crit_out else ''}critical ticket finishes on {days[end_crit[0]]}." if end_crit and end_crit[0] < len(days) else "",
          f"Lane hours used: {used:.0f} of {total:.0f} ({used / total:.0%}).")
    if unplaced:
        print("Do not fit in the window:", " ".join(sorted(unplaced)))
    # the line velocity.py --checkpoint reads: the lane model is stricter than schedule.py's pooled days (serial chains)
    if crit_out:
        print("Critical tickets that do not fit:", " ".join(crit_out))
    for k1, k2, fs in clashes[:20]:
        print(f"clash: {k1} and {k2} run at the same time and both name {', '.join(fs[:3])}")
    print(f"{len(clashes)} file clashes between parallel tickets")
    # Rust tickets share one CARGO_TARGET_DIR (disk), so parallel cargo builds queue on its lock: warn above two at once
    rust = {k for k in files if any(f.endswith((".rs", ".toml", ".lean")) for f in files[k])}
    hot = []
    for i, d in enumerate(days):
        segs = [(st[1], en[1], k) for k, _, st, en in runs if st[0] == i and k in rust]
        for t0, t1, k in segs:
            n = sum(1 for a0, a1, _ in segs if a0 < t1 and t0 < a1)
            if n > 2: hot.append(d); break
    if hot: print("more than two Rust lanes at once on:", ", ".join(sorted(set(hot))), "(cores and 16 GB of RAM: stagger them)")


if __name__ == "__main__":
    main()

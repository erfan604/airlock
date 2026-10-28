#!/usr/bin/env python3
"""Re-plan ticket days against daily capacity, dependencies and gate deadlines.

Usage: python3 scripts/schedule.py [--dir plan/tickets] [--start <first day with unspent capacity>] [--factor 1.6] [--apply]
Reads <dir>/AIR-*.md front matter and <dir>/capacity.json (agent hours per day). Tickets owned by erfan keep their day.
Greedy list scheduling, day by day: among tickets whose dependencies are already placed (earlier, or earlier the same
day), take the most urgent first (gate deadline, then tier Floor < Should < Defer, then most transitive dependents) and
pack it into the day if it fits the remaining capacity. Tickets marked `critical: true` define their gate; they and everything they
depend on (the critical path) are scheduled before anything else, so non-critical work absorbs any slip. Prints per-day load and every ticket that lands after its gate.
--factor multiplies the estimate of every ticket without a `reviewed:` field (the cold-start review of 2026-10-21 found
reviewed tickets at 1.4 to 1.7 times their first estimate), so the plan can be checked against calibrated hours.
--lane-hours (default 8) is the most estimated work one agent lane does in a day: a ticket starts where the last of its
same-day dependencies finished, and work past the lane's hours continues on the next days (reserving their capacity), so a
dependency chain can no longer be packed into one day out of the pooled capacity. 0 restores the pooled model.
--scale multiplies every estimate, reviewed or not: at a checkpoint, pass measured hours divided by estimated hours of the
tickets done so far.
--drop AIR-x,AIR-y treats those tickets as cut for a what-if (a cut ticket never blocks its dependents); it refuses --apply.
--apply rewrites the `day:` field of each ticket; without it nothing changes. Re-run after any slip.
--start (default: today, never before the product build starts on 2026-10-28) is the first day whose capacity is still unspent: the
morning run uses today, the evening checkpoint tomorrow. Every ticket not done, cut or owned by erfan is scheduled from that
day, whatever its old `day:` says (a ticket left unfinished yesterday is still work); only prep tickets are left alone: dated before
the window, or on the G0 checklist (is_prep). A ticket in progress counts its full estimate.
"""
import argparse, json, os, re, sys
from datetime import date, timedelta

# re-dated 2026-10-21 to the calibrated critical path (factor 1.3); Freeze, G5 and G6 unchanged
GATE_DUE = {"G0": "2026-10-30", "G1": "2026-11-02", "G1b": "2026-11-05", "G2": "2026-11-07", "G3": "2026-11-09",
            "G4": "2026-11-09", "Freeze": "2026-11-10", "G5": "2026-11-12", "G6": "2026-11-13"}
TIER = {"Floor": 0, "Should": 1, "Defer": 2}
WINDOW = "2026-10-28"   # the product build starts Wed Oct 28 (plan D16: the rules count code since Oct 19); tickets dated earlier are prep


def is_prep(v):
    """A prep ticket keeps its day and takes no window capacity: dated before the window, or on the G0 checklist (since D16 the
    window starts before G0, and the checklist is a dated human checkpoint, not lane work)."""
    return v["day"] < WINDOW or v["gate"] == "G0"


def default_start(days_ahead=0):
    return max(WINDOW, (date.today() + timedelta(days=days_ahead)).isoformat())


def load(d):
    out = {}
    for n in sorted(os.listdir(d)):
        if not re.match(r"AIR-\d{3}.*\.md$", n):
            continue
        text = open(os.path.join(d, n), encoding="utf-8").read()
        fm = text.split("---")[1]
        def g(k):
            m = re.search(rf"^{k}:\s*([^\n#]*)", fm, re.M)
            return m.group(1).strip() if m else ""
        deps = [x.strip() for x in g("depends_on").strip("[]").split(",") if x.strip()]
        out[g("id")] = dict(file=n, gate=g("gate"), tier=g("tier"), est=float(g("estimate_h") or 0), owner=g("owner"),
                            status=g("status"), day=g("day"), deps=deps, critical=g("critical") == "true",
                            reviewed=bool(g("reviewed")))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="plan/tickets")
    ap.add_argument("--start", default=default_start(), help="first day with unspent capacity (default today, from 2026-10-28)")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--regate", action="store_true", help="with --apply, move late non-critical tickets to the gate they make")
    ap.add_argument("--factor", type=float, default=1.0, help="multiply estimates of tickets without a reviewed: field")
    ap.add_argument("--lane-hours", type=float, default=8.0, help="most hours one lane works per day; 0 = pooled capacity")
    ap.add_argument("--scale", type=float, default=1.0, help="multiply every estimate (measured hours / estimated hours at a checkpoint)")
    ap.add_argument("--drop", default="", help="comma-separated ticket ids to treat as cut for a what-if (never written by --apply)")
    a = ap.parse_args()
    T = load(a.dir)
    dropped = {x.strip() for x in a.drop.split(",") if x.strip()}
    unknown = dropped - set(T)
    if unknown:
        sys.exit(f"--drop: unknown ticket ids {', '.join(sorted(unknown))}")
    for k in dropped:
        T[k]["status"] = "cut"
    for v in T.values():
        if not v["reviewed"]:
            v["est"] *= a.factor
        v["est"] *= a.scale
    cap = {k: float(v) for k, v in json.load(open(os.path.join(a.dir, "capacity.json"))).items() if not k.startswith("_")}
    # transitive dependents count, for priority
    children = {k: [j for j in T if k in T[j]["deps"]] for k in T}
    memo = {}
    def reach(k):
        if k not in memo:
            s = set()
            for c in children[k]:
                s.add(c); s |= reach(c)
            memo[k] = s
        return memo[k]
    # the critical path: every ticket marked critical plus everything it transitively depends on
    crit = set()
    def mark(k):
        if k in crit or k not in T:
            return
        crit.add(k)
        for d in T[k]["deps"]:
            mark(d)
    for k, v in T.items():
        if v["critical"]:
            mark(k)
    fixed = {k for k, v in T.items() if v["owner"] == "erfan" or v["status"] in ("done", "cut") or is_prep(v)}
    placed = {k: ("" if T[k]["status"] == "cut" else T[k]["day"]) for k in fixed}   # a cut ticket never blocks a dependent
    fin = {k: 0.0 for k in fixed}          # hour within its finish day at which a ticket ends (lane model)
    L = a.lane_hours if a.lane_hours > 0 else float("inf")
    todo = [k for k in T if k not in fixed]
    day = date.fromisoformat(a.start)
    last = date.fromisoformat(max(cap)) + timedelta(days=10)
    load_by_day, reserved = {}, {}
    def free(ds):
        return cap.get(ds, 0.0) - reserved.get(ds, 0.0)
    while todo and day <= last:
        ds = day.isoformat()
        progress = True
        while progress:
            progress = False
            ready = [k for k in todo if all(d in placed and placed[d] <= ds for d in T[k]["deps"])]
            ready.sort(key=lambda k: (k not in crit, GATE_DUE.get(T[k]["gate"], "2099"), TIER.get(T[k]["tier"], 3),
                                      -len(reach(k)), k))
            for k in ready:
                e = T[k]["est"]
                start = max([fin[d] for d in T[k]["deps"] if placed.get(d) == ds] or [0.0])
                if start >= L - 1e-9:
                    continue
                parts, d, need, off = [], day, e, start   # (day, hours) the ticket's lane works, from today on
                while need > 1e-9:
                    h = min(need, L - off)
                    parts.append((d.isoformat(), h)); need -= h; off = 0.0; d += timedelta(days=1)
                    if d > last:
                        break
                if need > 1e-9 or any(h > free(x) + 1e-9 for x, h in parts):
                    continue
                for x, h in parts:
                    reserved[x] = reserved.get(x, 0.0) + h
                    load_by_day[x] = load_by_day.get(x, 0.0) + h
                placed[k] = parts[-1][0]
                fin[k] = (start if len(parts) == 1 else 0.0) + parts[-1][1]
                todo.remove(k)
                progress = True
                break
        day += timedelta(days=1)
    late = [(k, placed.get(k, "unplaced"), T[k]["gate"]) for k in T if k not in fixed
            and (k not in placed or placed[k] > GATE_DUE.get(T[k]["gate"], "2099"))]
    print("day         capacity  load")
    for ds in sorted(load_by_day):
        print(f"{ds}  {cap.get(ds, 0):8.1f}  {load_by_day[ds]:5.1f}")
    moved = sum(1 for k in T if k not in fixed and placed.get(k) != T[k]["day"])
    print(f"\n{len(T) - len(fixed)} tickets scheduled, {moved} change day, {len(late)} land after their gate")
    for k, d, g in sorted(late, key=lambda x: (GATE_DUE.get(x[2], "2099"), x[0])):
        print(f"  LATE {k} {T[k]['tier']:6s} {T[k]['est']:4.1f}h gate {g} ({GATE_DUE.get(g)}) planned {d}")
    order = list(GATE_DUE)
    regated = []
    if a.apply and dropped:
        sys.exit("--drop is a what-if; run --apply without it after setting status: cut in the tickets")
    if a.apply:
        gate = {k: v["gate"] for k, v in T.items()}
        if a.regate:
            for k, v in T.items():
                if k in fixed or k not in placed or v["critical"] or k in crit:
                    continue
                if placed[k] > GATE_DUE.get(v["gate"], "2099"):
                    gate[k] = next((g for g in order if GATE_DUE[g] >= placed[k] and order.index(g) >= order.index(v["gate"])), "G6")
            # a ticket can never sit in an earlier gate than something it depends on: carry moves to dependents
            changed = True
            while changed:
                changed = False
                for k, v in T.items():
                    if k in fixed or v["critical"] or k in crit or v["status"] == "cut":
                        continue
                    need = max((gate[d] for d in v["deps"] if d in T and T[d]["status"] != "cut"),
                               key=lambda g: order.index(g) if g in order else -1, default=gate[k])
                    if need in order and gate[k] in order and order.index(need) > order.index(gate[k]):
                        gate[k] = need; changed = True
            regated = [(k, T[k]["gate"], gate[k]) for k in T if gate[k] != T[k]["gate"]]
        for k, v in T.items():
            if k in fixed:
                continue
            p = os.path.join(a.dir, v["file"]); s = open(p, encoding="utf-8").read()
            s2 = s
            if k in placed:
                s2 = re.sub(r"^(day:\s*)\S+", lambda m: m.group(1) + placed[k], s2, count=1, flags=re.M)
            if gate[k] != v["gate"]:
                s2 = re.sub(r"^(gate:\s*)\S+", lambda m: m.group(1) + gate[k], s2, count=1, flags=re.M)
            if s2 != s:
                open(p, "w", encoding="utf-8").write(s2)
        for k, g0, g1 in regated:
            print(f"  REGATE {k} {g0} -> {g1}")
        print(f"applied ({len(regated)} regated)")
        late = [x for x in late if x[0] not in {r[0] for r in regated}]
    sys.exit(1 if late else 0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Offline test of schedule.py's lane model on a synthetic ticket folder. Last line: SCHEDULE TESTS OK."""
import json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def ticket(d, tid, est, deps, gate="G6", day="2026-11-01"):
    open(os.path.join(d, f"{tid}-x.md"), "w").write(
        f"---\nid: {tid}\ntitle: t\nepic: E\ntier: Floor\ngate: {gate}\nday: {day}\nestimate_h: {est}\nowner: agent\n"
        f"status: todo\ndepends_on: [{', '.join(deps)}]\nreviewed: 2026-10-21\n---\n## Goal\n")


def days(d, lane, start="2026-11-01"):
    out = subprocess.run([sys.executable, os.path.join(HERE, "schedule.py"), "--dir", d, "--start", start,
                          "--lane-hours", str(lane), "--apply"], capture_output=True, text=True)
    got = {}
    for n in os.listdir(d):
        if n.endswith("-x.md"):
            t = open(os.path.join(d, n)).read()
            got[re.search(r"^id: (\S+)", t, re.M).group(1)] = re.search(r"^day: (\S+)", t, re.M).group(1)
    return got, out.stdout


def fail(name, msg):
    print(f"FAIL {name}: {msg}"); sys.exit(1)


with tempfile.TemporaryDirectory() as d:
    json.dump({"2026-11-01": 30, "2026-11-02": 30, "2026-11-03": 30}, open(os.path.join(d, "capacity.json"), "w"))
    ticket(d, "AIR-001", 5, []); ticket(d, "AIR-002", 5, ["AIR-001"]); ticket(d, "AIR-003", 5, ["AIR-002"])
    got, _ = days(d, 0)
    if set(got.values()) != {"2026-11-01"}:
        fail("pooled", f"a 15 h chain fits one 30 h day in the pooled model, got {got}")
    got, out = days(d, 8)
    want = {"AIR-001": "2026-11-01", "AIR-002": "2026-11-02", "AIR-003": "2026-11-02"}
    if got != want:   # 001 ends at 5 h; 002 runs 3 h on day 1 and 2 h on day 2; 003 runs from 2 h to 7 h on day 2
        fail("chain", f"want {want}, got {got}")
    if "2026-11-01      30.0    8.0" not in out:
        fail("load", "day 1 load must be 8.0 (5 h of AIR-001 plus 3 h of AIR-002)\n" + out)

with tempfile.TemporaryDirectory() as d:
    json.dump({"2026-11-01": 8, "2026-11-02": 8, "2026-11-03": 2}, open(os.path.join(d, "capacity.json"), "w"))
    ticket(d, "AIR-010", 11, [])
    got, out = days(d, 8)
    if got != {"AIR-010": "2026-11-02"}:
        fail("multi_day", f"an 11 h ticket at 8 h a lane finishes on day 2, got {got}")
    if "2026-11-02       8.0    3.0" not in out:
        fail("multi_day_load", "day 2 must carry the 3 h remainder\n" + out)

with tempfile.TemporaryDirectory() as d:
    json.dump({"2026-11-01": 8, "2026-11-02": 1}, open(os.path.join(d, "capacity.json"), "w"))
    ticket(d, "AIR-020", 11, [], gate="G1")
    got, out = days(d, 8)
    if "LATE AIR-020" not in out or "unplaced" not in out:
        fail("no_room", "a ticket whose remainder has no capacity must stay unplaced and late\n" + out)

# Morning of Nov 2: AIR-030 was planned for Nov 1 and is not done, so it is still work and moves to Nov 2 (before the fix it
# counted as done because its day was before --start). AIR-031 depends on it. AIR-032 is a prep ticket dated before the
# window and keeps its day.
with tempfile.TemporaryDirectory() as d:
    json.dump({"2026-11-01": 8, "2026-11-02": 8, "2026-11-03": 8}, open(os.path.join(d, "capacity.json"), "w"))
    ticket(d, "AIR-030", 4, []); ticket(d, "AIR-031", 4, ["AIR-030"]); ticket(d, "AIR-032", 2, [], day="2026-10-25")
    got, out = days(d, 8, start="2026-11-02")
    if got != {"AIR-030": "2026-11-02", "AIR-031": "2026-11-02", "AIR-032": "2026-10-25"}:
        fail("slipped", f"an unfinished ticket dated before --start is rescheduled from --start; prep stays: {got}\n" + out)

# 2026-10-28 (plan D16): the window starts Oct 28, so a G0 checklist ticket dated after it is still prep: it keeps its day,
# takes no window capacity and is never reported late (before the fix the scheduler moved AIR-275 to Nov 10).
with tempfile.TemporaryDirectory() as d:
    json.dump({"2026-10-29": 8, "2026-10-30": 8, "2026-10-31": 8}, open(os.path.join(d, "capacity.json"), "w"))
    ticket(d, "AIR-040", 8, [], gate="G1", day="2026-10-29"); ticket(d, "AIR-041", 1, [], gate="G0", day="2026-10-30")
    got, out = days(d, 8, start="2026-10-29")
    if got.get("AIR-041") != "2026-10-30" or "LATE AIR-041" in out:
        fail("g0_prep", f"a G0 ticket keeps its day and is not late: {got}\n" + out)
    if got.get("AIR-040") != "2026-10-29":
        fail("g0_prep_capacity", f"the G0 ticket takes no window capacity: {got}\n" + out)

print("SCHEDULE TESTS OK")

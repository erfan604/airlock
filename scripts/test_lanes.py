#!/usr/bin/env python3
"""Offline test of lanes.py on a synthetic plan. Last line: LANES TESTS OK."""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def fail(name, msg):
    print(f"FAIL {name}: {msg}"); sys.exit(1)


def ticket(d, tid, est, deps, scope="", crit=False, gate="G6", day="2026-11-01"):
    open(os.path.join(d, f"{tid}-x.md"), "w").write(
        f"---\nid: {tid}\ntitle: t\nepic: E\ntier: Floor\ngate: {gate}\nday: {day}\nestimate_h: {est}\nowner: claude\n"
        f"status: todo\ndepends_on: [{', '.join(deps)}]\nreviewed: 2026-10-22\n" + ("critical: true\n" if crit else "")
        + f"---\n## Goal\n## Scope\n{scope}\n")


with tempfile.TemporaryDirectory() as d:
    json.dump({"2026-11-01": 16, "2026-11-02": 16}, open(os.path.join(d, "capacity.json"), "w"))
    # A (6 h) feeds B (4 h); C (10 h) is independent and long; D and E both edit scripts/check.sh
    ticket(d, "AIR-001", 6, []); ticket(d, "AIR-002", 4, ["AIR-001"]); ticket(d, "AIR-003", 10, [])
    ticket(d, "AIR-004", 2, [], "- `scripts/check.sh` add a step"); ticket(d, "AIR-005", 2, [], "- `scripts/check.sh` add another step")
    # AIR-006 only runs the gate and AIR-007 hands its check.sh edit to another ticket: neither stops at a human prompt
    ticket(d, "AIR-006", 1, [], "- `scripts/check.sh full` is green. The wiring into `scripts/check.sh` stays with AIR-004, which adds it.")
    out = subprocess.run([sys.executable, os.path.join(HERE, "lanes.py"), "--dir", d, "--from", "2026-11-01", "--days", "2"],
                         capture_output=True, text=True).stdout
    day1 = out.split("2026-11-02")[0]
    if "2 lanes of 8.0 h" not in day1:
        fail("lanes", "16 h at 8 h a lane is two lanes of 8 h\n" + out)
    # B starts only after A ends (6 h) on whichever lane is free; it must not appear before A in day 1
    if day1.find("AIR-002") != -1 and day1.find("AIR-002") < day1.find("AIR-001"):
        fail("dependency", "AIR-002 printed before AIR-001\n" + out)
    if "AIR-003 8.0h ->" not in day1 or "AIR-003 2.0h (cont.)" not in out:
        fail("carry", "a 10 h ticket runs 8 h on day 1 and continues 2 h on day 2\n" + out)
    if "Lane hours used: 25 of 32" not in out:
        fail("used", "6 + 4 + 10 + 2 + 2 + 1 = 25 of 32 lane hours\n" + out)
    if "clash" in out and "AIR-004 and AIR-005" in out and "scripts/check.sh" not in out:
        fail("clash", out)
    if "AIR-004 2.0h!" not in out or "needs Erfan at the keyboard (protected file prompt): AIR-004 (scripts/check.sh)" not in out:
        fail("gated", "a ticket whose Scope edits scripts/check.sh is marked ! and listed for the day\n" + out)
    if "AIR-006 1.0h!" in out or "AIR-006 (" in out:
        fail("gated", "running check.sh or deferring its edit is not an edit\n" + out)
    if "AIR-001 6.0h!" in out:
        fail("gated", "a ticket with no protected file in its Scope is not marked\n" + out)

# A serial chain that fits the day's pooled hours (6 + 4 <= 16) but not one 8 h lane: the critical AIR-002 is reported, and
# dropping its blocker as a what-if makes it fit
with tempfile.TemporaryDirectory() as d:
    json.dump({"2026-11-01": 16}, open(os.path.join(d, "capacity.json"), "w"))
    ticket(d, "AIR-001", 6, []); ticket(d, "AIR-002", 4, ["AIR-001"], crit=True)
    lanes = lambda *x: subprocess.run([sys.executable, os.path.join(HERE, "lanes.py"), "--dir", d, "--from", "2026-11-01", "--days", "0", *x],
                                      capture_output=True, text=True)
    out = lanes().stdout
    if "Critical tickets that do not fit: AIR-002" not in out or "Last placed critical ticket" not in out:
        fail("critical_out", "AIR-002 runs 2 h of 4 on the lane and is reported\n" + out)
    out = lanes("--drop=AIR-001").stdout
    if "Critical tickets that do not fit" in out or "Do not fit" in out:
        fail("drop", "with AIR-001 cut, AIR-002 starts at 0 h and fits\n" + out)
    r = lanes("--drop=AIR-999")
    if r.returncode == 0 or "unknown ticket ids AIR-999" not in r.stderr:
        fail("drop_unknown", r.stdout + r.stderr)

# Nov 2: AIR-001 was dated Nov 1 and is not done, so it runs on Nov 2 (it is not treated as done)
with tempfile.TemporaryDirectory() as d:
    json.dump({"2026-11-01": 8, "2026-11-02": 8}, open(os.path.join(d, "capacity.json"), "w"))
    ticket(d, "AIR-001", 6, [])
    out = subprocess.run([sys.executable, os.path.join(HERE, "lanes.py"), "--dir", d, "--from", "2026-11-02", "--days", "1"],
                         capture_output=True, text=True).stdout
    if "2026-11-02" not in out or "lane 1: AIR-001 6.0h" not in out or "2026-11-01  (" in out:
        fail("slipped", "an unfinished ticket dated before --from runs from --from\n" + out)

# Day 1 has 3 lanes and three 10 h tickets, so each carries 2 h into day 2, which has only 2 lanes. The third must resume on
# day 2 as soon as a lane frees (at 2 h), not sit parked until day 3 (bug found by the tail review, 2026-10-22).
with tempfile.TemporaryDirectory() as d:
    json.dump({"2026-11-01": 24, "2026-11-02": 16, "2026-11-03": 8}, open(os.path.join(d, "capacity.json"), "w"))
    ticket(d, "AIR-001", 10, []); ticket(d, "AIR-002", 10, []); ticket(d, "AIR-003", 10, [])
    out = subprocess.run([sys.executable, os.path.join(HERE, "lanes.py"), "--dir", d, "--from", "2026-11-01", "--days", "3"],
                         capture_output=True, text=True).stdout
    day2 = out.split("2026-11-02")[1].split("2026-11-03")[0]
    day3 = out.split("2026-11-03")[1].split("* critical")[0]
    if day2.count("(cont.)") != 3 or "AIR-00" in day3:
        fail("parked", "all three carried tickets finish on day 2; none waits for day 3\n" + out)

# 2026-10-28 (plan D16): a G0 checklist ticket dated inside the window is prep (schedule.is_prep): no lane runs it and it takes
# no lane hours, the same rule schedule.py applies (test g0_prep there).
with tempfile.TemporaryDirectory() as d:
    json.dump({"2026-10-29": 8, "2026-10-30": 8}, open(os.path.join(d, "capacity.json"), "w"))
    ticket(d, "AIR-040", 8, [], gate="G1", day="2026-10-29"); ticket(d, "AIR-041", 1, [], gate="G0", day="2026-10-30")
    out = subprocess.run([sys.executable, os.path.join(HERE, "lanes.py"), "--dir", d, "--from", "2026-10-29", "--days", "2"],
                         capture_output=True, text=True).stdout
    if "AIR-041" in out or "Lane hours used: 8 of 16" not in out:
        fail("g0_prep_lanes", "the G0 ticket takes no lane and no lane hours\n" + out)

print("LANES TESTS OK")

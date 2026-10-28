#!/usr/bin/env python3
"""Offline test of clock.py on a synthetic ticket. Last line: CLOCK TESTS OK."""
import os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def fail(name, msg):
    print(f"FAIL {name}: {msg}"); sys.exit(1)


def clock(d, *args):
    return subprocess.run([sys.executable, os.path.join(HERE, "clock.py"), *args, "--dir", d], capture_output=True, text=True)


def field(d, key):
    t = open(os.path.join(d, "AIR-900-x.md")).read()
    m = re.search(rf"^{key}:\s*(\S+)", t, re.M)
    return m.group(1) if m else None


def fresh(d):
    open(os.path.join(d, "AIR-900-x.md"), "w").write(
        "---\nid: AIR-900\ntitle: t\nestimate_h: 2\nstatus: todo\n---\n## Goal\n")


with tempfile.TemporaryDirectory() as d:
    fresh(d)
    clock(d, "start", "AIR-900", "--at", "2026-10-28T08:00")
    r = clock(d, "stop", "AIR-900", "--at", "2026-10-28T09:30")
    if field(d, "actual_h") != "1.5" or field(d, "status") != "done":
        fail("plain", f"start 08:00, stop 09:30 is 1.5 h done: {r.stdout}{r.stderr}")

with tempfile.TemporaryDirectory() as d:
    # start, pause, resume with start, stop: 1.0 h before the pause plus 0.5 h after the resume, the wait not counted
    fresh(d)
    clock(d, "start", "AIR-900", "--at", "2026-10-28T08:00")
    clock(d, "pause", "AIR-900", "--at", "2026-10-28T09:00")
    clock(d, "start", "AIR-900", "--at", "2026-10-28T10:00")
    r = clock(d, "stop", "AIR-900", "--at", "2026-10-28T10:30")
    if field(d, "actual_h") != "1.5":
        fail("resume", f"1.0 h banked plus 0.5 h resumed is 1.5 h: {r.stdout}{r.stderr}")

with tempfile.TemporaryDirectory() as d:
    # 2026-10-28: stop right after a pause, without a start, counted the hours before the pause twice (AIR-021 recorded 0.3 h
    # for 0.2 h). Stop and a second pause now refuse until start resumes the clock, and the ticket is left unchanged.
    fresh(d)
    clock(d, "start", "AIR-900", "--at", "2026-10-28T08:00")
    clock(d, "pause", "AIR-900", "--at", "2026-10-28T09:00")
    before = open(os.path.join(d, "AIR-900-x.md")).read()
    for action in ("stop", "pause"):
        r = clock(d, action, "AIR-900", "--at", "2026-10-28T09:10")
        if r.returncode == 0 or "run start to resume" not in r.stderr:
            fail(f"paused_{action}", f"{action} on a paused ticket must refuse: {r.returncode} {r.stdout}{r.stderr}")
    if open(os.path.join(d, "AIR-900-x.md")).read() != before:
        fail("paused_unchanged", "a refused stop or pause must not write the ticket")

print("CLOCK TESTS OK")

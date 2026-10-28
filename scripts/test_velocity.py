#!/usr/bin/env python3
"""Offline test of clock.py and velocity.py on a synthetic ticket folder. Last line: VELOCITY TESTS OK."""
import os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
run = lambda *a: subprocess.run([sys.executable, *a], capture_output=True, text=True)


def fail(name, msg):
    print(f"FAIL {name}: {msg}"); sys.exit(1)


def ticket(d, tid, est, reviewed=True):
    open(os.path.join(d, f"{tid}-x.md"), "w").write(
        f"---\nid: {tid}\ntitle: t\nepic: E\ntier: Floor\ngate: G1\nday: 2026-11-01\nestimate_h: {est}\nowner: claude\n"
        f"status: todo\ndepends_on: []\n" + ("reviewed: 2026-10-22\n" if reviewed else "") + "---\n## Goal\nkeep this body\n")


with tempfile.TemporaryDirectory() as d:
    ticket(d, "AIR-001", 2); ticket(d, "AIR-002", 4); ticket(d, "AIR-003", 2, reviewed=False)
    open(os.path.join(d, "capacity.json"), "w").write('{"2026-11-01": 24}')
    r = run(os.path.join(HERE, "clock.py"), "stop", "AIR-001", "--dir", d)
    if r.returncode == 0 or "run start first" not in (r.stdout + r.stderr):
        fail("stop_before_start", "stop without start must refuse")
    for tid, a, b in [("AIR-001", "2026-11-01T17:00", "2026-11-01T19:30"), ("AIR-002", "2026-11-01T19:30", "2026-11-01T23:30")]:
        run(os.path.join(HERE, "clock.py"), "start", tid, "--dir", d, "--at", a)
        r = run(os.path.join(HERE, "clock.py"), "stop", tid, "--dir", d, "--at", b, "--minus", "30" if tid == "AIR-001" else "0")
        if r.returncode != 0:
            fail("clock", r.stderr)
    t1 = open(os.path.join(d, "AIR-001-x.md")).read()
    if not re.search(r"^actual_h: 2\.0$", t1, re.M) or "status: done" not in t1 or "keep this body" not in t1:
        fail("clock_fields", "AIR-001 must be done with actual_h 2.0 (2.5 h minus 30 min) and its body untouched\n" + t1)
    r = run(os.path.join(HERE, "velocity.py"), "--dir", d)
    if "s = 1.00" not in r.stdout.splitlines()[0]:        # 2.0 + 4.0 actual against 2 + 4 estimated
        fail("velocity", r.stdout)
    # an unreviewed ticket counts at estimate x factor: 3 h actual on a 2 h unreviewed ticket at factor 1.5 is s = 1.0
    run(os.path.join(HERE, "clock.py"), "start", "AIR-003", "--dir", d, "--at", "2026-11-02T00:00")
    run(os.path.join(HERE, "clock.py"), "stop", "AIR-003", "--dir", d, "--at", "2026-11-02T03:00")
    r = run(os.path.join(HERE, "velocity.py"), "--dir", d, "--factor", "1.5")
    if "9.0 h actual against 9.0 h estimated, s = 1.00" not in r.stdout:
        fail("factor", r.stdout)

    # the checkpoint decides over the band s .. s + 0.05; this plan has room, so every point needs no drops
    r = run(os.path.join(HERE, "velocity.py"), "--dir", d, "--factor", "1.5", "--checkpoint", "--from", "2026-11-01")
    if r.returncode != 0 or "  s = 1.00: no drops" not in r.stdout or "  s = 1.05: no drops" not in r.stdout \
            or "every critical ticket places with no drops across the band" not in r.stdout \
            or "remaining work planned from 2026-11-01" not in r.stdout:
        fail("checkpoint_band", r.stdout + r.stderr)

print("VELOCITY TESTS OK")

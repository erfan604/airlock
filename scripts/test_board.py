#!/usr/bin/env python3
"""Offline tests of board.py: the context-file check and the GitHub gate report (AIR-007). Last line: BOARD TESTS OK <n>."""
import json, os, stat, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


CASES = []


def fail(name, msg):
    print(f"FAIL {name}: {msg}"); sys.exit(1)


def case(name):
    CASES.append(name)


with tempfile.TemporaryDirectory() as root:
    tdir = os.path.join(root, "plan", "tickets"); os.makedirs(tdir)
    os.makedirs(os.path.join(root, "web", "src")); open(os.path.join(root, "web", "src", "App.tsx"), "w").write("x")
    open(os.path.join(tdir, "AIR-001-x.md"), "w").write(
        "---\nid: AIR-001\ntitle: t\nepic: E01\ntier: Floor\ngate: G1\nday: 2026-11-01\nestimate_h: 1\nowner: claude\n"
        "status: todo\ndepends_on: []\n---\n## Goal\ng\n## Context to load\n1. web/src/App.tsx (the console root)\n2. web/src/Missing.tsx\n"
        "## Scope\ns\n## Interfaces\ni\n## Acceptance checks\n1. `true` exits 0\n## Tests to write first\nt\n## Out of scope\no\n## Notes\nn\n")
    out = subprocess.run([sys.executable, os.path.join(HERE, "board.py"), "--dir", tdir, "--check"], capture_output=True, text=True)
    text = out.stdout + out.stderr
    # 2026-10-23: the path pattern tried `ts` before `tsx`, so an existing App.tsx was reported as a missing App.ts
    case("tsx")
    if "App.ts " in text or "App.ts\n" in text or "web/src/App.ts does" in text:
        fail("tsx", "an existing .tsx context file is read as .ts\n" + text)
    case("missing")
    if "Missing.tsx" not in text:
        fail("missing", "a .tsx context file that does not exist must still be reported, with its real name\n" + text)


# GitHub gate report (AIR-007). Tickets: 001 (G1b), 002 needs 001, 003 cut through its issue, 004 unmapped and done in its
# file, 005 needs 004, 006 unmapped and todo, 007 needs 006. The map leaves 004 and 006 out, as AIR-006 leaves out E13.
def ticket(tid, gate="G1b", est="1", status="todo", deps=""):
    return (f"---\nid: {tid}\ntitle: t{tid}\nepic: E00\ntier: Floor\ngate: {gate}\nday: 2026-11-01\nestimate_h: {est}\n"
            f"owner: claude\nstatus: {status}\ndepends_on: [{deps}]\n---\n## Goal\ng\n## Context to load\n1. none\n## Scope\ns\n"
            "## Interfaces\ni\n## Acceptance checks\n1. `true` exits 0\n## Tests to write first\nt\n## Out of scope\no\n## Notes\nn\n")


def gh_folder(root, issues, status001="done"):
    tdir = os.path.join(root, "plan", "tickets"); os.makedirs(tdir)
    specs = {"AIR-001": dict(status=status001), "AIR-002": dict(deps="AIR-001", est="2"), "AIR-003": dict(est="4", status="cut"),
             "AIR-004": dict(gate="G0", status="done"), "AIR-005": dict(deps="AIR-004"), "AIR-006": dict(gate="G0"),
             "AIR-007": dict(deps="AIR-006", est="0.5")}
    for tid, kw in specs.items():
        open(os.path.join(tdir, f"{tid}-x.md"), "w").write(ticket(tid, **kw))
    json.dump({"AIR-001": 1, "AIR-002": 2, "AIR-003": 3, "AIR-005": 5, "AIR-007": 7}, open(os.path.join(tdir, "github_map.json"), "w"))
    path = os.path.join(root, "issues.json"); json.dump(issues, open(path, "w"))
    return tdir, path


def board(*args, env=None):
    r = subprocess.run([sys.executable, os.path.join(HERE, "board.py"), *args], capture_output=True, text=True, env=env)
    return r.returncode, r.stdout, r.stderr


BASE = json.load(open(os.path.join(HERE, "fixtures", "gh-issues.json")))


def with_issue(n, **kw):
    out = json.loads(json.dumps(BASE))
    for i in out:
        if i["number"] == n:
            i.update(kw)
    return out


with tempfile.TemporaryDirectory() as root:    # (1) an open dependency: its dependent is not ready
    tdir, iss = gh_folder(root, with_issue(1, state="OPEN", stateReason=""), status001="todo")
    rc, out, err = board("--dir", tdir, "--github", "--issues-json", iss, "--gate", "G1b")
    case("open-dep")
    if rc != 0 or out.splitlines()[2:] != ["next ready AIR-001"]:
        fail("open-dep", f"with issue 1 open, AIR-002 must wait and AIR-001 is next\n{rc} {out}{err}")

with tempfile.TemporaryDirectory() as root:    # (2) the dependency closed COMPLETED: the dependent is ready and named
    tdir, iss = gh_folder(root, BASE)
    rc, out, err = board("--dir", tdir, "--github", "--issues-json", iss, "--gate", "G1b")
    case("closed-dep")
    if rc != 0 or out.splitlines()[2:] != ["next ready AIR-002"]:
        fail("closed-dep", f"issue 1 closed COMPLETED must make AIR-002 the next ready\n{rc} {out}{err}")
    rc, out, err = board("--dir", tdir, "--github", "--issues-json", iss)
    if rc != 0 or "- AIR-002" not in open(os.path.join(tdir, "BOARD.md")).read().split("## Ready to start now")[1].split("\n## ")[0]:
        fail("closed-dep", f"AIR-002 must be under Ready to start now\n{rc} {out}{err}")

with tempfile.TemporaryDirectory() as root:    # (3) closed NOT_PLANNED with label cut counts as cut and leaves hours left
    tdir, iss = gh_folder(root, BASE)
    rc, out, err = board("--dir", tdir, "--github", "--issues-json", iss, "--gate", "G1b")
    case("cut")
    lines = out.splitlines()
    # G1b holds 001 (done), 002 (2 h), 003 (cut, 4 h), 005 (1 h), 007 (0.5 h): open 3 of 4 non-cut, 3.5 h left
    if rc != 0 or lines[:2] != ["gate G1b open 3 of 4", "hours left 3.5"]:
        fail("cut", f"a cut issue is neither done nor open and its 4 h leave hours left\n{rc} {out}{err}")

with tempfile.TemporaryDirectory() as root:    # (4) unmapped tickets keep their file status and are listed, not errors
    tdir, iss = gh_folder(root, with_issue(2, state="CLOSED", stateReason="COMPLETED"))
    rc, out, err = board("--dir", tdir, "--github", "--issues-json", iss)
    case("unmapped")
    text = open(os.path.join(tdir, "BOARD.md")).read() if rc == 0 else ""
    unm = text.split("## Unmapped")[1].split("\n## ")[0] if "## Unmapped" in text else ""
    ready = text.split("## Ready to start now")[1].split("\n## ")[0] if text else ""
    drift = text.split("## Drift")[1].split("\n## ")[0] if "## Drift" in text else ""
    if rc != 0 or "AIR-004" not in unm or "AIR-006" not in unm or "- AIR-005" not in ready or "- AIR-007" in ready or "AIR-004" in drift:
        fail("unmapped", f"unmapped 004 (done) frees 005, unmapped 006 (todo) holds 007, both listed and never drift\n{rc} {out}{err}\n{text}")
    rc, out, err = board("--dir", tdir, "--github", "--issues-json", iss, "--gate", "G1b")
    if out.splitlines()[2:] != ["next ready AIR-005"]:
        fail("unmapped", f"--gate must name AIR-005 once 001 and 002 are done\n{out}{err}")

with tempfile.TemporaryDirectory() as root:    # (5) file todo, issue closed COMPLETED: one drift line
    tdir, iss = gh_folder(root, BASE, status001="todo")
    rc, out, err = board("--dir", tdir, "--github", "--issues-json", iss)
    case("drift")
    text = open(os.path.join(tdir, "BOARD.md")).read() if rc == 0 else ""
    drift = [l for l in (text.split("## Drift")[1].split("\n## ")[0] if "## Drift" in text else "").splitlines() if l.startswith("- ")]
    if rc != 0 or drift != ["- AIR-001 file open issue done"] or not out.strip().endswith("1 drift; wrote " + tdir + "/BOARD.md (github)"):
        fail("drift", f"expected exactly one drift line for AIR-001\n{rc} {out}{err}\n{drift}")

with tempfile.TemporaryDirectory() as root:    # (6) gh failing: exit 3, a one-line reason, no traceback
    tdir, iss = gh_folder(root, BASE)
    fake = os.path.join(root, "bin"); os.makedirs(fake)
    open(os.path.join(fake, "gh"), "w").write("#!/bin/sh\necho 'error connecting to api.github.com' >&2\nexit 1\n")
    os.chmod(os.path.join(fake, "gh"), stat.S_IRWXU)
    env = dict(os.environ, PATH=fake + os.pathsep + os.environ["PATH"])
    rc, out, err = board("--dir", tdir, "--github", "--repo", "x/airlock", env=env)
    case("gh-down")
    if rc != 3 or "github unavailable: error connecting to api.github.com" not in out + err or "Traceback" in out + err:
        fail("gh-down", f"a failing gh must give exit 3 and one reason line\n{rc} {out}{err}")

with tempfile.TemporaryDirectory() as root:    # unknown gate exits 2; --gate without --github reads the front matter
    tdir, iss = gh_folder(root, BASE, status001="todo")
    rc, out, err = board("--dir", tdir, "--gate", "G9")
    case("gate-unknown")
    if rc != 2:
        fail("gate-unknown", f"--gate G9 must exit 2\n{rc} {out}{err}")
    rc, out, err = board("--dir", tdir, "--gate", "G1b")
    case("gate-files")
    # from the files: 001 todo (next ready), 003 cut, so 4 open of 4 non-cut and 1 + 2 + 1 + 0.5 = 4.5 h
    if rc != 0 or out.splitlines() != ["gate G1b open 4 of 4", "hours left 4.5", "next ready AIR-001"]:
        fail("gate-files", f"without --github the front matter decides\n{rc} {out}{err}")

print(f"BOARD TESTS OK {len(CASES)}")

#!/usr/bin/env python3
"""Regenerate the ticket board from plan/tickets/*.md front matter, and validate the tickets.

Usage: python3 scripts/board.py [--dir plan/tickets] [--check] [--github [--repo <owner/name>] [--issues-json <file>]] [--gate <G>]
  --check  exit 1 if any ticket is invalid (missing fields or sections, unknown or cyclic dependencies); writes nothing.
Without --check: writes <dir>/BOARD.md: tickets grouped by gate in gate order, hour totals, and the list of tickets ready to start.
  --github  statuses come from the GitHub issues of <dir>/github_map.json (AIR-006): open is open; closed as not planned or
            labelled cut is cut; any other closed issue is done. Tickets missing from the map keep their file status and are
            listed under "## Unmapped"; a file status that disagrees with its issue is listed under "## Drift".
            Issues come from `gh issue list --repo <repo>` (repo from --repo or AIRLOCK_REPO) or from --issues-json.
            When gh fails it prints "github unavailable: <reason>" and exits 3.
  --gate G  prints three lines instead (gate G open k of n, hours left h, next ready AIR-###|none) and writes nothing;
            an unknown gate exits 2.
Standard library only, so it runs before any project dependency is installed.
"""
import argparse, json, os, re, subprocess, sys
from collections import defaultdict

GATES = ["G0", "G1", "G1b", "G2", "G3", "G4", "Freeze", "G5", "G6"]
STATUSES = ["todo", "ready", "in_progress", "blocked", "review", "done", "cut"]
REQUIRED = ["id", "title", "epic", "tier", "gate", "day", "estimate_h", "owner", "status", "depends_on"]
SECTIONS = ["## Goal", "## Context to load", "## Scope", "## Interfaces", "## Acceptance checks",
            "## Tests to write first", "## Out of scope", "## Notes"]


def parse(path):
    text = open(path, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        return None, text, ["no front matter"]
    meta, errors = {}, []
    for line in m.group(1).splitlines():
        line = line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if ":" not in line:
            errors.append(f"bad front matter line: {line!r}")
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            v = [x.strip() for x in v[1:-1].split(",") if x.strip()]
        meta[k.strip()] = v
    return meta, m.group(2), errors


def file_status(meta):
    """The front matter status reduced to the three states GitHub can express."""
    s = meta.get("status")
    return s if s in ("done", "cut") else "open"


def issue_status(issue):
    labels = {lab.get("name") for lab in issue.get("labels") or []}
    if issue.get("state") == "OPEN":
        return "open"
    return "cut" if issue.get("stateReason") == "NOT_PLANNED" or "cut" in labels else "done"


def github_unavailable(reason):
    print(f"github unavailable: {reason}")
    sys.exit(3)


def load_github(a):
    """Returns ({ticket id: issue number}, {issue number: issue}); exits 3 with one reason line when it cannot."""
    map_path = os.path.join(a.dir, "github_map.json")
    if not os.path.isfile(map_path):
        github_unavailable(f"no {map_path} (AIR-006 writes it when it imports the tickets)")
    gmap = json.load(open(map_path, encoding="utf-8"))
    if a.issues_json:
        issues = json.load(open(a.issues_json, encoding="utf-8"))
    else:
        if not a.repo:
            github_unavailable("no repository (pass --repo <owner/name> or set AIRLOCK_REPO)")
        cmd = ["gh", "issue", "list", "--repo", a.repo, "--state", "all", "--limit", "400",
               "--json", "number,state,stateReason,labels,milestone,title"]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True)
        except FileNotFoundError:
            github_unavailable("gh is not installed")
        if r.returncode != 0:
            github_unavailable((r.stderr.strip().splitlines() or [f"gh exited {r.returncode}"])[0])
        try:
            issues = json.loads(r.stdout)
        except ValueError:
            github_unavailable("gh printed something that is not JSON")
    return gmap, {i["number"]: i for i in issues}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="plan/tickets")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--github", action="store_true")
    ap.add_argument("--repo", default=os.environ.get("AIRLOCK_REPO"))
    ap.add_argument("--issues-json")
    ap.add_argument("--gate")
    a = ap.parse_args()
    if a.gate is not None and a.gate not in GATES:
        print(f"unknown gate {a.gate} (one of {', '.join(GATES)})", file=sys.stderr)
        sys.exit(2)
    tickets, problems = {}, []
    for name in sorted(os.listdir(a.dir)):
        if not re.match(r"AIR-\d{3}.*\.md$", name):
            continue
        meta, body, errs = parse(os.path.join(a.dir, name))
        problems += [f"{name}: {e}" for e in errs]
        if meta is None:
            continue
        for k in REQUIRED:
            if k not in meta:
                problems.append(f"{name}: missing field {k}")
        for sec in SECTIONS:
            if sec not in body:
                problems.append(f"{name}: missing section {sec}")
        if meta.get("gate") not in GATES:
            problems.append(f"{name}: unknown gate {meta.get('gate')}")
        if meta.get("status") not in STATUSES:
            problems.append(f"{name}: unknown status {meta.get('status')}")
        if not name.startswith(str(meta.get("id", "?"))):
            problems.append(f"{name}: file name does not start with id {meta.get('id')}")
        tid = meta.get("id", name[:7])
        if tid in tickets:
            problems.append(f"{name}: duplicate id {tid}")
        meta["_file"] = name
        tickets[tid] = meta
    deps = {t: (m.get("depends_on") or []) for t, m in tickets.items()}
    for t, ds in deps.items():
        for d in ds:
            if d not in tickets:
                problems.append(f"{t}: depends on unknown {d}")
    # cycle check (depth-first search)
    state = {}
    def visit(t, stack):
        if state.get(t) == 1:
            problems.append("dependency cycle: " + " -> ".join(stack + [t]))
            return
        if state.get(t) == 2:
            return
        state[t] = 1
        for d in deps.get(t, []):
            if d in tickets:
                visit(d, stack + [t])
        state[t] = 2
    for t in tickets:
        visit(t, [])
    # gate order sanity: a ticket should not depend on a later gate
    gi = {g: i for i, g in enumerate(GATES)}
    for t, ds in deps.items():
        for d in ds:
            if "cut" in (tickets[t].get("status"), tickets.get(d, {}).get("status")):
                continue   # a cut ticket has no gate to keep
            if d in tickets and gi.get(tickets[d].get("gate"), 0) > gi.get(tickets[t].get("gate"), 0):
                problems.append(f"{t} ({tickets[t].get('gate')}) depends on {d} in a later gate ({tickets[d].get('gate')})")
    # context references: every file a ticket asks a session to load must exist already, or be produced by a ticket it
    # depends on (matched on the path's last two components, since Scope sections often use paths relative to a crate)
    root = os.path.abspath(os.path.join(a.dir, "..", ".."))
    # longest extension first and a guard after it: "App.tsx" must not match as "App.ts" (fixed 2026-10-23, test_board.py)
    path_re = re.compile(r"((?:[\w.-]+/)+[\w.-]+\.(?:md|rs|lean|py|tsx|ts|json|sh|yml|toml|html|mjs|txt))(?![\w])")
    bodies = {t: open(os.path.join(a.dir, m["_file"]), encoding="utf-8").read() for t, m in tickets.items()}
    def section(text, name):
        mm = re.search(rf"## {name}\n(.*?)(?:\n## |\Z)", text, re.S)
        return mm.group(1) if mm else ""
    produces = {t: section(x, "Scope") + section(x, "Acceptance checks") + section(x, "Interfaces") + section(x, "Tests to write first")
                for t, x in bodies.items()}
    all_files = []
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in (".git", "target", "node_modules", ".lake", "refs")]
        all_files += [os.path.join(dp, f) for f in fn]
    anc_memo = {}
    def ancestors(t):
        if t not in anc_memo:
            out = set()
            for d in deps.get(t, []):
                if d in tickets:
                    out |= {d} | ancestors(d)
            anc_memo[t] = out
        return anc_memo[t]
    for t, x in bodies.items():
        for pth in sorted(set(path_re.findall(section(x, "Context to load")))):   # sorted: BOARD.md is the same on every run
            if pth.startswith(("http", "www.")) or os.path.exists(os.path.join(root, pth)) or os.path.exists(os.path.join(root, "kit", pth)):
                continue
            if any(f.endswith(pth) and f[-len(pth) - 1] in "/ " for f in all_files):   # fragment of a path with spaces
                continue
            tail = "/".join(pth.split("/")[-2:])
            prods = [u for u, txt in produces.items() if u != t and tail in txt]
            if not prods:
                problems.append(f"{t}: context file {pth} does not exist and no ticket produces it")
            elif not any(u in ancestors(t) for u in prods):
                problems.append(f"{t}: context file {pth} is produced by {', '.join(sorted(prods))}, which {t} does not depend on")
    # produced names (cold-start review lesson 4): an acceptance check or a first test can only run if every name it uses
    # exists, so a backticked name that exactly one other ticket produces must come from a ticket this one depends on.
    # Only Acceptance checks and Tests to write first are scanned (Scope may describe later work); a line that cites the
    # producer's id is an explicit, deliberate reference (for example an ignored test "enabled by AIR-105") and is skipped.
    name_re = re.compile(r"`([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)(?:\([^`]*\))?`")
    producers = defaultdict(set)
    for t, x in bodies.items():
        bullets = []
        for line in section(x, "Interfaces").splitlines():     # join wrapped continuation lines onto their bullet
            if bullets and line.startswith("  ") and not line.lstrip().startswith(("-", "|")):
                bullets[-1] += " " + line.strip()
            else:
                bullets.append(line)
        for line in bullets:
            low = line.lower()
            if "| produced" in low:
                part = line
            elif low.lstrip("- ").startswith("produces"):
                part = re.split(r"(?i)consumes", line)[0]
            else:
                continue
            for nm in name_re.findall(part):
                if len(nm) > 3:
                    producers[nm].add(t)
    lint_hits = []
    for t, x in bodies.items():
        anc = ancestors(t) | {t}
        text = section(x, "Acceptance checks") + "\n" + section(x, "Tests to write first")
        seen = set()
        for line in text.splitlines():
            for nm in name_re.findall(line):
                prods = producers.get(nm)
                if "_" not in nm and nm.islower():   # plain words (amount, reject, test) collide across layers
                    continue
                if not prods or len(prods) != 1 or prods & anc or nm in seen or any(pid in line for pid in prods):
                    continue
                seen.add(nm)
                lint_hits.append(f"{t}: a check or first test uses `{nm}`, produced by {next(iter(prods))}, which {t} does not depend on")
    problems += lint_hits
    # command lints (G1b review): cargo test takes one name filter before "--"; a check that only greps the pre-filled ABI
    # list passes before the work exists
    for t, x in bodies.items():
        checks = section(x, "Acceptance checks")
        for cmd in re.findall(r"(cargo test[^`]*)`", checks):
            cmd = re.split(r"&&|;|\|", cmd)[0].strip()          # only the cargo test segment of a chained command
            before = cmd.split(" -- ")[0].split()
            words, skip = [], False
            for w in before[2:]:
                if skip:
                    skip = False
                    continue
                if w in ("--test", "--lib", "--bin", "--example", "-p", "--package", "--features", "--manifest-path", "--target"):
                    skip = w != "--lib"
                    continue
                if w.startswith("-") or re.match(r"^\d*[<>]", w):   # flags and redirections such as 2>&1
                    continue
                words.append(w)
            if len(words) > 1:
                problems.append(f"{t}: `{cmd}` has {len(words)} name filters; cargo test accepts one before --")
            elif len(words) == 1 and not any(f in before for f in ("--test", "--lib", "--bin", "--example")):
                problems.append(f"{t}: `{cmd}` filters by test NAME and prints 'ok. 0 passed' when nothing matches; "
                                "use `cargo test --test <file>` and a floor on the passed count")
        for item in re.split(r"\n(?=\d+\. )", checks):
            cmds = re.findall(r"`([^`]+)`", item)
            runnable = [c for c in cmds if re.match(r"^(cd |source |cargo |pnpm |node |npx |python3 |bash |scripts/|grep |test |git |near |!)", c)]
            if runnable and all("abi_expected.txt" in c and c.lstrip("! ").startswith("grep") for c in runnable):
                problems.append(f"{t}: an acceptance check only greps abi_expected.txt, which AIR-041 pre-fills, so it passes before the work exists")
    # reuse lints: every id on a "- Reuse inventory:" bullet is an entry (### heading or ## section) of the file it names, and a
    # ticket that an inventory's section 0 table names carries the bullet (an R6.6 typo once pointed three tickets at nothing)
    reuse_dir = next((d for d in (os.path.join(root, "plan", "reuse"),
                                  os.path.join(os.environ.get("AIRLOCK_RESEARCH", ""), "plan", "reuse")) if os.path.isdir(d)), "")
    id_re = re.compile(r"\b(?:R\d+\.\d+(?: to R\d+\.\d+)?|[FWMTPL]\d+(?: to [FWMTPL]\d+)?)\b|section \d+")
    def expand(i):
        mm = re.match(r"([A-Z])(\d+)(?:\.(\d+))? to [A-Z](\d+)(?:\.(\d+))?$", i)
        if not mm:
            return [i]
        if mm.group(3) is not None:
            return [f"{mm.group(1)}{mm.group(2)}.{n}" for n in range(int(mm.group(3)), int(mm.group(5)) + 1)]
        return [f"{mm.group(1)}{n}" for n in range(int(mm.group(2)), int(mm.group(4)) + 1)]
    for fname in (["REUSE_near.md", "REUSE_general.md"] if reuse_dir else []):
        inv = open(os.path.join(reuse_dir, fname), encoding="utf-8").read()
        entries = set(re.findall(r"^### ((?:R\d+\.\d+)|(?:[FWMTPL]\d+))\b", inv, re.M)) | {f"section {n}" for n in re.findall(r"^## (\d+)\.", inv, re.M)}
        table = inv.split("## 0.", 1)[1].split("\n## 1.", 1)[0] if "## 0." in inv else ""
        named = {f"AIR-{n}" for row in table.splitlines() if row.startswith("| AIR-") for n in re.findall(r"\b(\d{3})\b", row.split("|")[1])}
        for t, x in bodies.items():
            bullet = next((ln for ln in x.splitlines() if ln.startswith("- Reuse inventory:")), "")
            part = next((p for p in bullet.split(" (each entry")[0].split(";") if fname in p), "")
            for i in id_re.findall(part):
                bad = [e for e in expand(i) if e not in entries]
                if bad:
                    problems.append(f"{t}: reuse id {', '.join(bad)} is not an entry of {fname}")
            if t in named and not part:
                problems.append(f"{t}: {fname} section 0 names this ticket but its '- Reuse inventory:' bullet does not cite {fname}")
    # effective statuses: the files, or GitHub for every mapped ticket (AIR-007)
    eff = {t: file_status(m) for t, m in tickets.items()}
    unmapped, drift = [], []
    if a.github:
        gmap, issues = load_github(a)
        for t in sorted(tickets):
            n = gmap.get(t)
            if n not in issues:
                unmapped.append(t if n is None else f"{t} (issue #{n} not found)")
                continue
            st = issue_status(issues[n])
            if st != eff[t]:
                drift.append(f"- {t} file {eff[t]} issue {st}")
            eff[t] = st
    if a.gate is not None:
        ids = sorted(t for t, m in tickets.items() if m.get("gate") == a.gate and eff[t] != "cut")
        open_ids = [t for t in ids if eff[t] == "open"]
        hours = sum(float(tickets[t].get("estimate_h", 0) or 0) for t in open_ids)
        nxt = next((t for t in open_ids if all(eff.get(d) == "done" for d in deps[t])), "none")
        print(f"gate {a.gate} open {len(open_ids)} of {len(ids)}")
        print(f"hours left {hours:.1f}")
        print(f"next ready {nxt}")
        return
    done = {t for t in tickets if eff[t] == "done"}
    if a.github:
        ready = [t for t in tickets if eff[t] == "open" and all(d in done for d in deps[t])]
    else:
        ready = [t for t, m in tickets.items() if m.get("status") in ("todo", "ready") and all(d in done for d in deps[t])]

    by_gate = defaultdict(list)
    for t, m in tickets.items():
        by_gate[m.get("gate")].append(t)
    lines = ["# Ticket board (generated by scripts/board.py; do not edit by hand)", ""]
    total = sum(float(m.get("estimate_h", 0) or 0) for t, m in tickets.items() if eff[t] != "cut")
    lines.append(f"{len(tickets)} tickets, {total:.0f} agent hours planned (cut tickets excluded).")
    lines.append("")
    lines.append("## Ready to start now")
    lines.append("")
    lines += [f"- {t} {tickets[t]['title']} ({tickets[t].get('gate')}, {tickets[t].get('tier')})" for t in sorted(ready)] or ["- none"]
    lines.append("")
    for g in GATES:
        ids = sorted(by_gate.get(g, []))
        if not ids:
            continue
        hours = sum(float(tickets[t].get("estimate_h", 0) or 0) for t in ids if eff[t] != "cut")
        ndone = sum(1 for t in ids if eff[t] == "done")
        lines.append(f"## {g}: {ndone} of {len(ids)} done, {hours:.0f} h")
        lines.append("")
        lines.append("| Id | Title | Epic | Tier | Day | Est h | Owner | Status | Depends on |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for t in ids:
            m = tickets[t]
            lines.append(f"| [{t}]({m['_file']}) | {m.get('title','')} | {m.get('epic','')} | {m.get('tier','')} | {m.get('day','')} | "
                         f"{m.get('estimate_h','')} | {m.get('owner','')} | {eff[t] if a.github else m.get('status','')} | {', '.join(deps[t]) or '-'} |")
        lines.append("")
    if a.github:
        lines += ["## Unmapped", "", "Not in github_map.json; they keep their file status (the E13 tickets are never imported).", ""]
        lines += [f"- {u}" for u in unmapped] or ["None."]
        lines += ["", "## Drift", ""]
        lines += drift or ["No drift."]
        lines.append("")
    if problems:
        lines.append("## Problems found")
        lines.append("")
        lines += [f"- {p}" for p in problems]
        lines.append("")
    if a.check:   # --check validates only; it never rewrites BOARD.md (safe inside check.sh and from copies of the folder)
        print(f"{len(tickets)} tickets, {len(ready)} ready, {len(problems)} problems (BOARD.md not written)")
    else:
        open(os.path.join(a.dir, "BOARD.md"), "w", encoding="utf-8").write("\n".join(lines))
        if a.github:
            print(f"{len(tickets)} tickets, {len(ready)} ready, {len(drift)} drift; wrote {a.dir}/BOARD.md (github)")
        else:
            print(f"{len(tickets)} tickets, {len(ready)} ready, {len(problems)} problems; wrote {a.dir}/BOARD.md")
    if a.check and problems:
        for p in problems:
            print("PROBLEM:", p)
        sys.exit(1)


if __name__ == "__main__":
    main()

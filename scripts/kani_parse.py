#!/usr/bin/env python3
# AIR-029: reads a `cargo kani` log and contracts/airlock-verdict/harnesses.toml and names every proof that is vacuous or
# fails for the wrong reason: an UNSATISFIABLE or UNREACHABLE cover, fewer satisfied covers than min_covers, a harness with
# no checks, a should_panic harness whose failing descriptions are not exactly [panic_message], a harness that is missing from
# or extra to the toml, a harness that never ran (Status: ERROR) and any Kani version but 0.68 (the log format is pinned).
# Usage: scripts/kani_parse.py LOG TOML   (python3 3.11 or later, tomllib, nothing else)
# Prints one problem per line, sorted, and exits 1; otherwise prints the KANI OK summary line and exits 0.
# The messages are read by test_kani_parse.py and AIR-028: change them in both places or not at all.
import re, sys, tomllib

def parse_log(lines):
    blocks, cur, final, dup = {}, None, None, []
    version = lines[0] if lines else ""
    for i, line in enumerate(lines):
        m = re.match(r"^Checking harness (\S+)\.\.\.$", line)
        if m:
            name = m.group(1).split("::")[-1]
            if name in blocks: dup.append(name)
            cur = {"checks": [], "verification": None}
            blocks[name] = cur
            continue
        if line.startswith("Manual Harness Summary:"): cur = None
        m = re.match(r"^Complete - (\d+) successfully verified harnesses, (\d+) failures, (\d+) total\.$", line)
        if m: final = int(m.group(1))
        if cur is None: continue
        m = re.match(r"^Check \d+: (\S+)$", line)
        if m and i + 2 < len(lines):
            st = re.match(r"^\t - Status: (\w+)$", lines[i + 1])
            ds = re.match(r'^\t - Description: "(.*)"$', lines[i + 2])
            if st: cur["checks"].append((m.group(1), st.group(1), ds.group(1).strip('"') if ds else ""))
            continue
        m = re.match(r"^VERIFICATION:- (SUCCESSFUL|FAILED)(?: \((.*)\))?$", line)
        if m: cur["verification"] = (m.group(1), m.group(2))
    return blocks, final, version, dup

def show(v): return "nothing" if not v else v[0] + (f" ({v[1]})" if v[1] else "")

def check(log_path, toml_path):
    entries = {h["name"]: h for h in tomllib.load(open(toml_path, "rb"))["harness"]}
    blocks, final, version, dup = parse_log(open(log_path, encoding="utf-8", errors="replace").read().splitlines())
    problems, covers_ok, panics_ok = [], 0, 0
    if not version.startswith("Kani Rust Verifier 0.68."): problems.append(f"kani version is not 0.68: {version}")
    problems += [f"duplicate harness name in log: {n}" for n in dup]
    problems += [f"harness not in harnesses.toml: {n}" for n in blocks if n not in entries]
    problems += [f"harness not run: {n}" for n in entries if n not in blocks]
    for n, b in blocks.items():
        e = entries.get(n)
        if e is None: continue
        if any(c[1] == "ERROR" for c in b["checks"]):
            # the proof never ran (a missing solver): its verdict, covers and failures say nothing, so name only the cause
            problems.append(f"{n}: tool error (Status: ERROR, likely a missing solver), not a counterexample")
            continue
        if not b["checks"]: problems.append(f"{n}: no checks at all (vacuous proof)")
        covers = [c for c in b["checks"] if re.search(r"\.cover\.\d+$", c[0])]
        problems += [f'{n}: cover "{c[2]}" is {c[1]}' for c in covers if c[1] != "SATISFIED"]
        sat = sum(1 for c in covers if c[1] == "SATISFIED")
        v = b["verification"]
        if sat < e.get("min_covers", 0): problems.append(f"{n}: {sat} covers satisfied, min_covers is {e['min_covers']}")
        if e["expect"] == "success":
            if v != ("SUCCESSFUL", None): problems.append(f"{n}: expected VERIFICATION SUCCESSFUL, got {show(v)}")
            else: covers_ok += sat
        else:
            if v != ("SUCCESSFUL", "encountered one or more panics as expected"):
                problems.append(f"{n}: should_panic harness did not fail as expected: {show(v)}")
            fails = [c[2] for c in b["checks"] if c[1] == "FAILURE"]
            if e["panic_message"] not in fails: problems.append(f'expected property "{e["panic_message"]}" not found in {n}')
            problems += [f'unexpected failure in {n}: "{d}"' for d in fails if d != e["panic_message"]]
            if set(fails) == {e["panic_message"]} and v and v[0] == "SUCCESSFUL": panics_ok += 1   # a set: one message can fail at two sites
    if final is None: problems.append("no Complete line in the log")
    elif final != len(entries): problems.append(f"Complete says {final} verified harnesses, harnesses.toml has {len(entries)}")
    return len(entries), covers_ok, panics_ok, sorted(problems)

if __name__ == "__main__":
    n, c, p, problems = check(sys.argv[1], sys.argv[2])
    print("\n".join(problems) if problems else f"KANI OK: {n} harnesses, {c} covers satisfied, {p} should_panic failed at the expected property")
    sys.exit(1 if problems else 0)

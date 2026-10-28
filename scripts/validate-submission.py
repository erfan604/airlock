#!/usr/bin/env python3
"""AIR-253: check .submission/payload.json against the submission contract of the rules page before Erfan's yes.

Usage: python3 scripts/validate-submission.py [--file .submission/payload.json] [--selftest]
Contract (refs/HACKATHON.md): exactly the eleven keys (no `website`, the spam trap); requestId a lowercase UUID; projectName
and leadName 2 to 80 characters; email valid and at most 160; size exactly one of 1, 2 - 4, 4 - 6, 6 - 8, 8+; tracks
non-empty, each of the thirteen ids once; nearAddress 2 to 64 characters, lowercase, fully matching the page's expression;
projectUrl and demoUrl http(s) and at most 300 characters; idea 20 to 2000 characters; consent true; body at most 12000 bytes.
Beyond the contract: tracks hold security and agents, and privacy only with a G4 IN line in docs/DECISIONS.md and a
`| TEE registration tx` line in docs/EVIDENCE.md; demoUrl is an x.com status link (an optional share query such as ?s=20 is
fine, twitter.com is refused); the idea has no [ ] < > left from the draft, every idea sentence with a claim verb of
docs/claim-verbs.txt is in README.md verbatim once its tags are removed, and the idea passes scripts/claims-lint.ts --file.
Prints the time left to 2026-11-14T23:59:00Z. Exit 0 with last line PAYLOAD OK, 1 on findings, 2 on a missing input,
3 after the deadline. Standard library only; the payload holds personal data, so this script never prints field values.
"""
import json, os, re, subprocess, sys, tempfile, uuid
from datetime import datetime, timezone

DEADLINE = datetime(2026, 11, 14, 23, 59, tzinfo=timezone.utc)
KEYS = ["requestId", "projectName", "leadName", "email", "size", "tracks", "nearAddress", "projectUrl", "demoUrl", "idea", "consent"]
SIZES = {"1", "2 - 4", "4 - 6", "6 - 8", "8+"}
TRACKS = {"defi", "thesis", "privacy", "business", "swarms", "security", "agents", "realworld", "games", "nfts", "memecoins", "social", "open"}
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s.]+")
NEAR_RE = re.compile(r"(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+")
URL_RE = re.compile(r"https?://\S+")
DEMO_RE = re.compile(r"https://x\.com/[A-Za-z0-9_]{1,15}/status/[0-9]{10,}(\?[A-Za-z0-9_=&%.-]+)?")
TAG_RE = re.compile(r"\s*\[(?:C\d+[a-z]?|S\d+|PA\d+)\]")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def squash(s):
    return re.sub(r"\s+", " ", s).strip()


def sentences(text):
    return [x for x in (squash(p) for p in re.split(r"(?<=[.!?])\s+", text)) if x]


def check(p, size_bytes, ctx):
    """Returns the findings for payload dict p. ctx: readme, verbs, g4, tee_row, lint (idea -> list of findings)."""
    f = []
    if not isinstance(p, dict):
        return ["the payload is not a JSON object"]
    extra = sorted(set(p) - set(KEYS))
    missing = [k for k in KEYS if k not in p]
    if extra:
        f.append("keys not in the contract: " + ", ".join(extra) + (" (website is the spam trap)" if "website" in extra else ""))
    if missing:
        f.append("missing keys: " + ", ".join(missing))
    def s(k):   # the value when it is a string, else ""; every rule below fails on ""
        v = p.get(k)
        return v if isinstance(v, str) else ""
    if not UUID_RE.fullmatch(s("requestId")):
        f.append("requestId is not a lowercase UUID")
    for k in ("projectName", "leadName"):
        if not 2 <= len(s(k)) <= 80:
            f.append(f"{k} must be 2 to 80 characters")
    if len(s("email")) > 160 or not EMAIL_RE.fullmatch(s("email")):
        f.append("email is not a valid address of at most 160 characters")
    if s("size") not in SIZES:
        f.append("size must be exactly one of 1, 2 - 4, 4 - 6, 6 - 8, 8+")
    tr = p.get("tracks")
    if not isinstance(tr, list) or not tr or not all(isinstance(t, str) for t in tr):
        f.append("tracks must be a non-empty list of track ids")
        tr = []
    else:
        bad = [t for t in tr if t not in TRACKS]
        if bad:
            f.append("unknown track ids: " + ", ".join(bad))
        if len(set(tr)) != len(tr):
            f.append("a track is listed twice")
        for need in ("security", "agents"):
            if need not in tr:
                f.append(f"tracks must hold {need} (plan/DECISIONS.md D4)")
        if "privacy" in tr and not (ctx["g4"] == "IN" and ctx["tee_row"]):
            f.append("privacy needs the G4 IN line in docs/DECISIONS.md and a TEE registration tx row in docs/EVIDENCE.md")
    na = s("nearAddress")
    if not 2 <= len(na) <= 64 or not NEAR_RE.fullmatch(na):
        f.append("nearAddress must be 2 to 64 characters and match the contract's lowercase account expression")
    for k in ("projectUrl", "demoUrl"):
        if len(s(k)) > 300 or not URL_RE.fullmatch(s(k)):
            f.append(f"{k} must be an http(s) URL of at most 300 characters")
    if s("demoUrl") and not DEMO_RE.fullmatch(s("demoUrl")):
        f.append("demoUrl must be the x.com status link of the demo post (twitter.com links are refused)")
    idea = s("idea")
    if not 20 <= len(idea) <= 2000:
        f.append("idea must be 20 to 2000 characters")
    if p.get("consent") is not True:
        f.append("consent must be true, and only after Erfan agreed to the contact notice")
    if size_bytes > 12000:
        f.append(f"body is {size_bytes} bytes, the limit is 12000")
    if idea:
        if re.search(r"[\[\]<>]", idea):
            f.append("idea still holds a draft bracket ([ ] < >)")
        readme = squash(TAG_RE.sub("", ctx["readme"]))
        verbs = [v for v in ctx["verbs"] if v]
        for sen in sentences(idea):
            if any(re.search(r"(?<![\w-])" + re.escape(v) + r"(?![\w-])", sen, re.I) for v in verbs) and sen not in readme:
                f.append("an idea sentence with a claim verb is not in README.md verbatim: " + sen[:80])
        f += ["claims lint: " + x for x in ctx["lint"](idea)]
    return f


def real_ctx():
    def read(path):
        try:
            return open(os.path.join(ROOT, path), encoding="utf-8").read()
        except OSError:
            return None
    readme, verbs = read("README.md"), read("docs/claim-verbs.txt")
    if readme is None or verbs is None:
        print("missing README.md or docs/claim-verbs.txt"); sys.exit(2)
    g4 = re.search(r"^G4 [0-9-]+ (IN|OUT)", read("docs/DECISIONS.md") or "", re.M)
    tee = re.search(r"^\| TEE registration tx", read("docs/EVIDENCE.md") or "", re.M)

    def lint(idea):
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as t:
            t.write(idea + "\n")
        try:
            r = subprocess.run(["node", os.path.join(ROOT, "scripts", "claims-lint.ts"), "--file", t.name],
                               capture_output=True, text=True, cwd=ROOT)
        except FileNotFoundError:
            return ["node is not on PATH (source scripts/env.sh first)"]
        finally:
            os.unlink(t.name)
        if r.returncode == 0:
            return []
        return [x for x in r.stdout.splitlines() if x.startswith(("FINDING", "FINAL", "INPUT"))] or ["exit %d" % r.returncode]
    return {"readme": readme, "verbs": [v.strip() for v in verbs.splitlines() if v.strip() and not v.startswith("#")],
            "g4": g4.group(1) if g4 else None, "tee_row": bool(tee), "lint": lint}


def selftest():
    readme = ("# AIRLOCK\n\nAIRLOCK refuse to let injected text choose who an agent pays [C1a]. "
              "The contract signs only payments whose recipient came from the owner [C3].\n")
    ctx = {"readme": readme, "verbs": ["refuse", "signs", "only", "always", "block"], "g4": "OUT", "tee_row": False, "lint": lambda idea: []}
    good = {"requestId": str(uuid.uuid4()), "projectName": "AIRLOCK", "leadName": "Test Lead", "email": "lead@example.com",
            "size": "1", "tracks": ["security", "agents"], "nearAddress": "airlock-team.near",
            "projectUrl": "https://github.com/example/airlock", "demoUrl": "https://x.com/example/status/1234567890123",
            "idea": "AIRLOCK refuse to let injected text choose who an agent pays. The contract signs only payments whose recipient came from the owner.",
            "consent": True}

    def variant(**kw):
        v = json.loads(json.dumps(good)); v.update(kw); return v
    cases = [
        ("valid payload", good, True),
        ("website key", variant(website="x"), False),
        ("size 2-4", variant(size="2-4"), False),
        ("privacy without TEE row", variant(tracks=["security", "agents", "privacy"]), False),
        ("idea of 2001 characters", variant(idea="a" * 2001), False),
        ("idea with [N]", variant(idea=good["idea"] + " It saves [N] hours."), False),
        ("idea sentence not in README", variant(idea=good["idea"] + " It will always block every attack."), False),
        ("track ai-security", variant(tracks=["security", "agents", "ai-security"]), False),
        ("twitter.com demoUrl", variant(demoUrl="https://twitter.com/example/status/1234567890123"), False),
        ("demoUrl with ?s=20", variant(demoUrl="https://x.com/example/status/1234567890123?s=20"), True),
        ("uppercase nearAddress", variant(nearAddress="Airlock.near"), False),
        ("consent false", variant(consent=False), False),
        ("body over 12000 bytes", good, False),
    ]
    bad = 0
    for name, payload, want_ok in cases:
        size = 12001 if name == "body over 12000 bytes" else len(json.dumps(payload).encode())
        ok = not check(payload, size, ctx)
        if ok != want_ok:
            bad += 1
            print(f"SELFTEST FAIL {name}: want {'ok' if want_ok else 'findings'}, got {check(payload, size, ctx) or 'ok'}")
    print("SELFTEST ok" if not bad else f"SELFTEST failed {bad}")
    return 0 if not bad else 1


def main():
    args = sys.argv[1:]
    if "--selftest" in args:
        sys.exit(selftest())
    path = args[args.index("--file") + 1] if "--file" in args and args.index("--file") + 1 < len(args) else ".submission/payload.json"
    left = DEADLINE - datetime.now(timezone.utc)
    if left.total_seconds() < 0:
        print("deadline passed: 2026-11-14T23:59:00Z"); sys.exit(3)
    print(f"time left {int(left.total_seconds() // 3600)}h{int(left.total_seconds() % 3600 // 60):02d}m to 2026-11-14T23:59:00Z")
    try:
        raw = open(path, "rb").read()
    except OSError:
        print(f"no payload at {path}"); sys.exit(2)
    try:
        p = json.loads(raw.decode("utf-8"))
    except ValueError:
        print("the payload is not valid JSON"); sys.exit(1)
    findings = check(p, len(raw), real_ctx())
    for x in findings:
        print("FINDING", x)
    print("PAYLOAD OK" if not findings else f"PAYLOAD FAILED ({len(findings)} findings)")
    sys.exit(0 if not findings else 1)


if __name__ == "__main__":
    main()

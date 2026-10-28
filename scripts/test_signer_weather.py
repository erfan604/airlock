#!/usr/bin/env python3
"""Offline test of signer-weather.py on synthetic FastNEAR histories. Last line: SIGNER WEATHER TESTS OK (<n> of <n>)."""
import base64, json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "signer-weather.py")
SIGNER = "v1.signer-prod.testnet"
NOW = 1_793_200_000_000_000_000  # ns
S = 1_000_000_000  # one second in ns
BLOCK = 0.58  # seconds per block, as measured on testnet
passed = 0


def fail(name, msg):
    print(f"FAIL {name}: {msg}"); sys.exit(1)


def b64(obj):
    return base64.b64encode(json.dumps(obj).encode()).decode()


def sign_tx(i, age_s, latency_s, domain=0, kind="ok"):
    """One sign transaction submitted age_s seconds before NOW. kind: ok | gas | timeout | empty | double | pending | rejected."""
    h = f"tx{i:05d}"
    t0 = NOW - int(age_s * S)
    b0 = 275_000_000 - int(age_s / BLOCK)
    sign = {"receipt": {"receiver_id": SIGNER, "predecessor_id": "caller.testnet", "receipt": {"Action": {"actions": [
        {"FunctionCall": {"method_name": "sign", "args": b64({"request": {"domain_id": domain, "path": "", "payload_v2": {"Ecdsa": "00" * 32}}}),
                          "gas": 20_000_000_000_000, "deposit": "1"}}]}}},
            "execution_outcome": {"block_height": b0 + 1, "block_timestamp": t0 + S // 2, "index": 0,
                                  "outcome": {"status": {"SuccessReceiptId": "cb" + h}, "gas_burnt": 7_700_000_000_000, "logs": []}}}
    receipts = [sign]
    if kind == "rejected":
        sign["execution_outcome"]["outcome"]["status"] = {"Failure": {"ActionError": {"index": 0, "kind": {"FunctionCallError": {
            "ExecutionError": "Smart contract panicked: Attached deposit is lower than required. Attached: 0, required: 1"}}}}}
    elif kind != "pending":
        bcb = b0 + max(1, int(latency_s / BLOCK))
        tcb = t0 + int(latency_s * S)
        if kind in ("ok", "double"):
            status = {"SuccessValue": b64({"scheme": "Secp256k1", "big_r": {"affine_point": "02" + "11" * 32}, "s": {"scalar": "22" * 32}, "recovery_id": 0})}
        elif kind == "empty":
            status = {"SuccessValue": ""}
        elif kind == "gas":
            status = {"Failure": {"ActionError": {"index": 0, "kind": {"FunctionCallError": {"ExecutionError": "Exceeded the prepaid gas."}}}}}
        else:
            status = {"SuccessReceiptId": "fot" + h}
        receipts.append({"receipt": {"receiver_id": SIGNER, "predecessor_id": SIGNER, "receipt": {"Action": {"actions": [
            {"FunctionCall": {"method_name": "return_signature_and_clean_state_on_success", "args": "", "gas": 7_000_000_000_000, "deposit": "0"}}]}}},
            "execution_outcome": {"block_height": bcb, "block_timestamp": tcb, "index": 0, "outcome": {"status": status, "gas_burnt": 1_000_000_000_000, "logs": []}}})
        if kind == "double":
            # a second sign in the same transaction: its callback ends 112 s later in the gas failure
            receipts.append(json.loads(json.dumps(receipts[-1])))
            receipts[-1]["execution_outcome"].update(block_height=bcb + 200, block_timestamp=tcb + 112 * S, index=1)
            receipts[-1]["execution_outcome"]["outcome"]["status"] = {"Failure": {"ActionError": {"index": 0, "kind": {
                "FunctionCallError": {"ExecutionError": "Exceeded the prepaid gas."}}}}}
        if kind == "timeout":
            receipts.append({"receipt": {"receiver_id": SIGNER, "predecessor_id": SIGNER, "receipt": {"Action": {"actions": [
                {"FunctionCall": {"method_name": "fail_on_timeout", "args": "", "gas": 2_000_000_000_000, "deposit": "0"}}]}}},
                "execution_outcome": {"block_height": bcb + 1, "block_timestamp": tcb + S // 2, "index": 0, "outcome": {"status": {"Failure": {
                    "ActionError": {"index": 0, "kind": {"FunctionCallError": {"ExecutionError": "Smart contract panicked: Request has timed out."}}}}},
                    "gas_burnt": 1_000_000_000_000, "logs": []}}})
    tx = {"transaction": {"hash": h, "signer_id": "caller.testnet", "receiver_id": SIGNER},
          "execution_outcome": {"block_height": b0, "block_timestamp": t0}, "receipts": receipts}
    return h, t0, tx


def respond_tx(i, age_s):
    """A node's respond call: present in the account history, never a sign."""
    h = f"rs{i:05d}"
    t0 = NOW - int(age_s * S)
    tx = {"transaction": {"hash": h, "signer_id": "node.testnet", "receiver_id": SIGNER},
          "execution_outcome": {"block_height": 275_000_000 - int(age_s / BLOCK), "block_timestamp": t0},
          "receipts": [{"receipt": {"receiver_id": SIGNER, "predecessor_id": "node.testnet", "receipt": {"Action": {"actions": [
              {"FunctionCall": {"method_name": "respond", "args": "", "gas": 30_000_000_000_000, "deposit": "0"}}]}}},
              "execution_outcome": {"block_height": 275_000_001 - int(age_s / BLOCK), "block_timestamp": t0 + S // 2, "index": 0,
                                    "outcome": {"status": {"SuccessValue": b64(None)}, "gas_burnt": 1, "logs": []}}}]}
    return h, t0, tx


def world(specs, page_size=200, extra_pages=0):
    """specs: list of (age_s, latency_s, domain, kind). Builds newest-first pages like the FastNEAR account API."""
    items, txs = [], {}
    for i, (age, lat, dom, kind) in enumerate(specs):
        h, t0, tx = sign_tx(i, age, lat, dom, kind)
        items.append((t0, h)); txs[h] = tx
        h2, t2, tx2 = respond_tx(i, max(0.0, age - lat))
        items.append((t2, h2)); txs[h2] = tx2
    items.sort(reverse=True)
    pages = []
    for k in range(0, len(items), page_size):
        pages.append({"account_txs": [{"transaction_hash": h, "tx_block_timestamp": str(t)} for t, h in items[k:k + page_size]],
                      "resume_token": f"tok{k // page_size + 1}" if k + page_size < len(items) or extra_pages else None})
    for _ in range(extra_pages):
        pages.append({"poison": True, "account_txs": [], "resume_token": None})
    return {"now_ns": NOW, "pages": pages, "transactions": txs}


def run(name, fixture, *args):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(fixture, f); path = f.name
    try:
        p = subprocess.run([sys.executable, "-I", TOOL, "--fixture", path, *args], capture_output=True, text=True, timeout=60)
    finally:
        os.unlink(path)
    lines = p.stdout.strip().splitlines()
    if not lines:
        fail(name, "no output; stderr: " + p.stderr)
    return p.returncode, lines[-1], p.stdout


def expect(name, fixture, args, code, verdict, *fragments):
    global passed
    rc, last, out = run(name, fixture, *args)
    if not re.fullmatch(r"SIGNER WEATHER (GOOD|SLOW|BAD|UNKNOWN) .*", last):
        fail(name, "last line is not a verdict: " + last)
    if rc != code or not last.startswith(f"SIGNER WEATHER {verdict} "):
        fail(name, f"want {verdict} exit {code}, got exit {rc}: {last}\n{out}")
    for frag in fragments:
        if frag not in last:
            fail(name, f"missing '{frag}' in: {last}")
    passed += 1


fast = [(300 + 60 * i, 4.0, 0, "ok") for i in range(40)]
# 1. forty fast signs: GOOD, nearest-rank p50 and p90
expect("good", world(fast), [], 0, "GOOD", "n=40", "p50=4.0s", "p90=4.0s", "failed=0 (0.0%)", "window=60m", "domain=0")
# 2. ten of forty at 30 s: p90 is 30 s, no failures: SLOW
slow = [(300 + 60 * i, 30.0 if i % 4 == 0 else 4.0, 0, "ok") for i in range(40)]
expect("slow", world(slow), [], 1, "SLOW", "n=40", "p90=30.0s", "failed=0")
# 3. two of forty end in the signer's callback running out of gas at 200 blocks: 5 percent is BAD
gas = fast[:38] + [(400, 116.0, 0, "gas"), (900, 116.0, 0, "gas")]
expect("bad-gas", world(gas), [], 2, "BAD", "n=40", "failed=2 (5.0%)")
# 4. the fail_on_timeout path (callback returns a promise, fail_on_timeout panics) counts as failed too
tmo = fast[:38] + [(400, 116.0, 0, "timeout"), (900, 116.0, 0, "timeout")]
expect("bad-timeout", world(tmo), [], 2, "BAD", "failed=2 (5.0%)")
# 5. one failure in forty, otherwise fast: SLOW (any failure is not GOOD)
one = fast[:39] + [(400, 116.0, 0, "gas")]
expect("one-failure", world(one), [], 1, "SLOW", "failed=1 (2.5%)")
# 6. p90 above 60 s without failures is BAD
crawl = [(300 + 60 * i, 70.0 if i % 3 == 0 else 4.0, 0, "ok") for i in range(40)]
expect("crawl", world(crawl), [], 2, "BAD", "p90=70.0s")
# boundaries: p90 of exactly 60 s is SLOW, exactly 10 s with no failure is GOOD
edge60 = [(300 + 60 * i, 60.0 if i % 4 == 0 else 4.0, 0, "ok") for i in range(40)]
expect("edge-60", world(edge60), [], 1, "SLOW", "p90=60.0s")
edge10 = [(300 + 60 * i, 10.0 if i % 4 == 0 else 4.0, 0, "ok") for i in range(40)]
expect("edge-10", world(edge10), [], 0, "GOOD", "p90=10.0s")
# 7. fewer than 20 resolved signs: UNKNOWN
expect("few", world(fast[:10]), [], 3, "UNKNOWN", "n=10")
# 8. domain filter: forty failing Ed25519 signs do not affect the secp256k1 verdict, but do under --domain 1 and --domain any
mixed = fast + [(330 + 60 * i, 116.0, 1, "gas") for i in range(40)]
expect("domain-0", world(mixed), [], 0, "GOOD", "n=40", "domain=0")
expect("domain-1", world(mixed), ["--domain", "1"], 2, "BAD", "n=40", "failed=40 (100.0%)", "domain=1")
expect("domain-any", world(mixed), ["--domain", "any"], 2, "BAD", "n=80", "failed=40 (50.0%)", "domain=any")
# 9. window: failures two hours old are outside a 60 minute window, inside a 180 minute one; paging stops at the window edge
old = fast + [(7200 + 30 * i, 116.0, 0, "gas") for i in range(40)]
expect("window-60", world(old, page_size=50), [], 0, "GOOD", "n=40")
expect("window-180", world(old, page_size=50), ["--minutes", "180"], 2, "BAD", "n=80", "window=180m")
# the last real page ends with signs older than the window, so the poison page after it must never be read
expect("paging-stops", world(fast + [(4000 + i, 4.0, 0, "ok") for i in range(3)], page_size=30, extra_pages=1), [], 0, "GOOD", "n=40")
# ...and a page that ends inside the window is followed (here into the poison page, which stops the tool)
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
    json.dump(world(fast, page_size=30, extra_pages=1), f); follow = f.name
p = subprocess.run([sys.executable, "-I", TOOL, "--fixture", follow], capture_output=True, text=True, timeout=60)
os.unlink(follow)
if p.returncode == 0 or "read a page past the window" not in p.stderr:
    fail("paging-follows", f"a page ending inside the window must be followed; exit {p.returncode}: {p.stdout} {p.stderr}")
passed += 1
# 10. signs from the last 150 s and signs with no callback yet are pending, not counted; a rejected sign (no deposit) is not weather
extra = fast + [(60, 4.0, 0, "ok"), (100, 0, 0, "pending"), (2000, 0, 0, "pending"), (500, 0, 0, "rejected")]
rc, last, out = run("pending", world(extra))
if rc != 0 or "n=40" not in last or "pending=3" not in out or "rejected=1" not in out:
    fail("pending", f"want GOOD n=40 with pending=3 rejected=1, got exit {rc}:\n{out}")
passed += 1
# 11. the API is unreachable: UNKNOWN, exit 3, says why
expect("unreachable", {"now_ns": NOW, "error": "connection refused"}, [], 3, "UNKNOWN", "unreachable")
# 12. distinct latencies 1 s to 40 s: nearest rank gives p50 20 s and p90 36 s
ranks = [(300 + 60 * i, float(i + 1), 0, "ok") for i in range(40)]
expect("ranks", world(ranks), [], 1, "SLOW", "p50=20.0s", "p90=36.0s")
# 13. a callback that returns an empty value is not a signature
empty = fast[:38] + [(400, 6.0, 0, "empty"), (900, 6.0, 0, "empty")]
expect("empty", world(empty), [], 2, "BAD", "failed=2 (5.0%)")
# 14. a transaction with two signs waits for both and fails if one fails
double = fast[:38] + [(400, 4.0, 0, "double"), (900, 4.0, 0, "double")]
expect("double", world(double), [], 2, "BAD", "failed=2 (5.0%)", "p90=4.0s")
expect("double-p90", world(fast[:34] + [(400 + i, 4.0, 0, "double") for i in range(6)]), [], 2, "BAD", "p90=116.0s")
# 15. thresholds are flags: --good-p90 20 makes the slow world GOOD
expect("flags", world(slow), ["--good-p90", "30"], 0, "GOOD")

print(f"SIGNER WEATHER TESTS OK ({passed} of {passed})")

#!/usr/bin/env python3
"""Signer weather: how the NEAR Chain Signatures signer has been answering `sign` over the last N minutes.

Reads public history from the FastNEAR transaction API (no key, read only) and prints one verdict line last:
  SIGNER WEATHER <GOOD|SLOW|BAD|UNKNOWN> n=<resolved> p50=<s>s p90=<s>s failed=<k> (<pct>%) window=<m>m domain=<d> signer=<id>
Exit 0 GOOD, 1 SLOW, 2 BAD, 3 UNKNOWN (fewer than --min-n resolved signs, or the API unreachable).

Latency is from the block that included the caller's transaction to the block that executed the signer's
`return_signature_and_clean_state_on_success` callback, so it is what a caller waits for. A sign whose callback did not
return a signature, an empty value included (the 200 block yield timed out: either `fail_on_timeout` panicked with `Request has timed out.` or the
callback ran out of its 7 Tgas, as every testnet timeout did from 2026-10-27 14Z) counts as failed, with its latency. A `sign`
receipt that itself failed (for example no deposit) is the caller's error, counted as rejected, not as weather.
Signs submitted in the last 150 s, or with no callback yet, are pending and not counted.

Measured on testnet over 3.3 days to 2026-10-27 (9,476 secp256k1 signs, notes/signer_latency_2026-10-27.md in the research repo):
p90 6.7 s and 1.3 percent timeouts overall, but hourly p90 ranged from 4.3 s to 118 s and timeouts up to 29 percent of an hour's signs;
61 of 81 hours were GOOD and 9 BAD. Mainnet over 979 signs had no failure.
Use before a recorded testnet run (AIR-166 golden runs, AIR-272, video capture): GOOD is the time to record.
Usage: signer-weather.py [--minutes 60] [--domain 0|1|any] [--signer v1.signer-prod.testnet] [--net test|main]
                         [--good-p90 10] [--bad-p90 60] [--bad-pct 5] [--min-n 20] [--fixture <file.json>]
"""
import argparse, base64, json, math, sys, time, urllib.request

SETTLE_S = 150  # a sign younger than this may still be inside its 200 block (about 116 s) yield window


class Unreachable(Exception):
    pass


class Live:
    def __init__(self, net):
        self.base = f"https://tx.{net}.fastnear.com/v0"
        self.now_ns = time.time_ns()

    def _post(self, path, body):
        last = None
        for i in range(3):
            try:
                req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(),
                                             headers={"content-type": "application/json", "user-agent": "curl/8.7.1"})
                return json.load(urllib.request.urlopen(req, timeout=30))
            except Exception as e:  # network, HTTP or JSON error: retry, then give up
                last = e; time.sleep(1 + 2 * i)
        raise Unreachable(f"{self.base}{path}: {last}")

    def page(self, account, token):
        body = {"account_id": account, "is_function_call": True, "desc": True, "limit": 200}
        if token:
            body["resume_token"] = token
        return self._post("/account", body)

    def transactions(self, hashes):
        out = []
        for i in range(0, len(hashes), 20):
            out += self._post("/transactions", {"tx_hashes": hashes[i:i + 20]})["transactions"]
        return out


class Fixture:
    """Offline transport for tests: {now_ns, pages: [...], transactions: {hash: tx}} or {now_ns, error}."""
    def __init__(self, path):
        self.d = json.load(open(path))
        self.now_ns = self.d["now_ns"]
        self.next = 0

    def page(self, account, token):
        if "error" in self.d:
            raise Unreachable(self.d["error"])
        p = self.d["pages"][self.next]; self.next += 1
        if p.get("poison"):
            raise SystemExit("read a page past the window")
        return p

    def transactions(self, hashes):
        return [self.d["transactions"][h] for h in hashes]


def calls(r):
    a = r["receipt"]["receipt"].get("Action")
    return [x["FunctionCall"] for x in (a["actions"] if a else []) if isinstance(x, dict) and "FunctionCall" in x]


def classify(tx, signer):
    """One row per sign transaction, or None when the transaction has no sign receipt to `signer`."""
    rs = sorted(tx["receipts"], key=lambda r: (r["execution_outcome"]["block_height"], r["execution_outcome"].get("index") or 0))
    signs = [r for r in rs if r["receipt"]["receiver_id"] == signer and any(f["method_name"] == "sign" for f in calls(r))]
    if not signs:
        return None
    s0 = signs[0]
    fc = next(f for f in calls(s0) if f["method_name"] == "sign")
    try:
        domain = json.loads(base64.b64decode(fc.get("args") or ""))["request"].get("domain_id")
    except Exception:
        domain = None  # legacy argument shape without domain_id
    row = {"t_tx": tx["execution_outcome"]["block_timestamp"], "domain": domain}
    if "Failure" in s0["execution_outcome"]["outcome"]["status"]:
        row["outcome"] = "rejected"; return row
    cbs = [r for r in rs if r is not s0 and r["receipt"]["receiver_id"] == signer
           and any(f["method_name"].startswith("return_signature") for f in calls(r))]
    if not cbs:
        row["outcome"] = "pending"; return row
    # a transaction with several signs is one row: it waited for the last callback, and failed if any returned no signature
    row["latency_s"] = (max(cb["execution_outcome"]["block_timestamp"] for cb in cbs) - row["t_tx"]) / 1e9
    row["outcome"] = "ok" if all(cb["execution_outcome"]["outcome"]["status"].get("SuccessValue") for cb in cbs) else "failed"
    return row


def nearest_rank(sorted_vals, p):
    return sorted_vals[max(0, math.ceil(p * len(sorted_vals)) - 1)]


def main():
    ap = argparse.ArgumentParser(description="Recent Chain Signatures latency and failures from public history.")
    ap.add_argument("--minutes", type=int, default=60)
    ap.add_argument("--domain", default="0", help="0 (secp256k1, the EVM lane), 1 (Ed25519) or any")
    ap.add_argument("--signer", default="v1.signer-prod.testnet")
    ap.add_argument("--net", default="test", choices=["test", "main"])
    ap.add_argument("--good-p90", type=float, default=10.0, help="GOOD needs p90 at or below this many seconds and no failure")
    ap.add_argument("--bad-p90", type=float, default=60.0, help="BAD when p90 is above this many seconds")
    ap.add_argument("--bad-pct", type=float, default=5.0, help="BAD when at least this percent of resolved signs failed")
    ap.add_argument("--min-n", type=int, default=20)
    ap.add_argument("--fixture", help=argparse.SUPPRESS)
    a = ap.parse_args()
    tag = f"window={a.minutes}m domain={a.domain} signer={a.signer}"
    src = Fixture(a.fixture) if a.fixture else Live(a.net)
    lo = src.now_ns - a.minutes * 60 * 10**9
    hi = src.now_ns - SETTLE_S * 10**9
    rows, token, pages = [], None, 0
    try:
        while True:
            p = src.page(a.signer, token); pages += 1
            items = p.get("account_txs") or []
            want = [x["transaction_hash"] for x in items if lo <= int(x["tx_block_timestamp"]) <= src.now_ns]
            for tx in src.transactions(list(dict.fromkeys(want))):
                r = classify(tx, a.signer)
                if r:
                    rows.append(r)
            token = p.get("resume_token")
            if not token or not items or min(int(x["tx_block_timestamp"]) for x in items) < lo:
                break
    except Unreachable as e:
        print(f"SIGNER WEATHER UNKNOWN unreachable: {e} {tag}"); return 3
    if a.domain != "any":
        rows = [r for r in rows if str(r["domain"]) == a.domain]
    pending = sum(1 for r in rows if r["outcome"] == "pending" or (r["outcome"] in ("ok", "failed") and r["t_tx"] > hi))
    rejected = sum(1 for r in rows if r["outcome"] == "rejected")
    done = [r for r in rows if r["outcome"] in ("ok", "failed") and r["t_tx"] <= hi]
    failed = sum(1 for r in done if r["outcome"] == "failed")
    print(f"pages={pages} resolved={len(done)} pending={pending} rejected={rejected}")
    if len(done) < a.min_n:
        print(f"SIGNER WEATHER UNKNOWN n={len(done)} (fewer than {a.min_n} resolved signs) {tag}"); return 3
    lat = sorted(r["latency_s"] for r in done)
    p50, p90 = nearest_rank(lat, 0.5), nearest_rank(lat, 0.9)
    pct = 100.0 * failed / len(done)
    if pct >= a.bad_pct or p90 > a.bad_p90:
        verdict, code = "BAD", 2
    elif failed == 0 and p90 <= a.good_p90:
        verdict, code = "GOOD", 0
    else:
        verdict, code = "SLOW", 1
    print(f"SIGNER WEATHER {verdict} n={len(done)} p50={p50:.1f}s p90={p90:.1f}s failed={failed} ({pct:.1f}%) {tag}")
    return code


if __name__ == "__main__":
    sys.exit(main())

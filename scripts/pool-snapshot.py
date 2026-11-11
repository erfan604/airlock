#!/usr/bin/env python3
"""Read-only snapshot of the live credit pool on the test network: account record, key kinds, a hash of the full raw state (sha256 of the
JSON list of sorted [key, value] pairs, base64 as view_state returns them) and every view, all at one block. Used around the code-only
redeploy of 2026-11-11 (docs/EVIDENCE.md, docs/evidence/pool-redeploy-before.json and -after.json).
Usage: pool-snapshot.py <out.json>. No key is read."""
import base64, hashlib, json, sys, urllib.request

RPC = "https://test.rpc.fastnear.com"
POOL = "pool.airlock-credit-c1108d.testnet"
CARD = "card.airlock-credit-c1108d.testnet"
LPS = ["lp1.airlock-credit-c1108d.testnet", "lp2.airlock-credit-c1108d.testnet", "borrower.airlock-credit-c1108d.testnet",
       "archc0ff40bf4e.testnet", "lender-vf1hib3df3.testnet", "lender-0f2w2vr3v6.testnet", "lender-8x136mujmt.testnet",
       "lender-lzg0iszbw5.testnet"]


def rpc(params):
    req = urllib.request.Request(RPC, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "query", "params": params}).encode(),
                                 {"content-type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=40))
    if "error" in d:
        raise SystemExit(f"rpc error: {d['error']}")
    return d["result"]


def view(method, args, height):
    r = rpc({"request_type": "call_function", "block_id": height, "account_id": POOL, "method_name": method,
             "args_base64": base64.b64encode(json.dumps(args).encode()).decode()})
    return json.loads(bytes(r["result"]).decode())


def main():
    out_path = sys.argv[1]
    acct = rpc({"request_type": "view_account", "finality": "final", "account_id": POOL})
    h = acct["block_height"]
    state = rpc({"request_type": "view_state", "block_id": h, "account_id": POOL, "prefix_base64": ""})
    pairs = sorted((v["key"], v["value"]) for v in state["values"])
    state_hash = hashlib.sha256(json.dumps(pairs).encode()).hexdigest()
    keys = rpc({"request_type": "view_access_key_list", "block_id": h, "account_id": POOL})["keys"]
    snap = {
        "block_height": h,
        "code_hash": acct["code_hash"],
        "amount": acct["amount"],
        "storage_usage": acct["storage_usage"],
        "state_entries": len(pairs),
        "state_sha256": state_hash,
        # the kind of each key, not the public key (the RPC call view_access_key_list shows those)
        "keys": sorted("FullAccess" if k["access_key"]["permission"] == "FullAccess" else "FunctionCall" for k in keys),
        "views": {
            "get_pool": view("get_pool", {}, h),
            "get_pool_passport": view("get_pool_passport", {}, h),
            "get_base_check_config": view("get_base_check_config", {}, h),
            "list_lines": view("list_lines", {}, h),
            "get_card": view("get_card", {"card": CARD}, h),
            "get_line": view("get_line", {"card": CARD}, h),
            "get_passport": view("get_passport", {"card": CARD}, h),
            "get_lp": {a: view("get_lp", {"account": a}, h) for a in LPS},
            "get_unclaimed": {a: view("get_unclaimed", {"account": a}, h) for a in LPS},
        },
    }
    json.dump(snap, open(out_path, "w"), indent=1, sort_keys=True)
    print(f"block {h} code {snap['code_hash']} balance {int(acct['amount']) / 1e24:.6f} storage {acct['storage_usage']} "
          f"state {len(pairs)} entries sha256 {state_hash[:16]} keys {len(keys)}")


main()

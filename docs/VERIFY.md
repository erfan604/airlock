# Verify

Three things worth a look first:
- Steal this agent: the agent's function-call key and an owner-signed task are published on NEAR testnet, every attempt is on chain and stolen is 0 NEAR so far. Results: "Steal this agent (live)" in `docs/EVIDENCE.md`; `pnpm challenge` serves the board.
- Hosted demo: the static replay console, built with `pnpm build:static` (not published yet, so build it locally with that command; see `docs/HOSTED_DEMO.md`).
- Proof transcripts: `pnpm proven:transcripts` (needs Node and pnpm) checks the committed Kani, Lean and differential output in `docs/evidence/`.

Rust: `pnpm try --text` and `pnpm bench:replay` need Rust 1.86. Check with `cargo --version`.

What can be checked with which tools, how long each command takes and the last line it prints. Every claim of the README has a row in `docs/CLAIMS.md` with its command and expected output (checked by `scripts/claims-lint.ts`, which resolves every tag).

| Tier | Needs | What it covers |
| --- | --- | --- |
| T0 | nothing to run | read `docs/CLAIMS.md`: each claim, its evidence, its command and its expected output |
| T1 | Node 24 and pnpm | the replay demo, the claims that need no other tool, the console and runtime tests |
| T2 | T1 and Rust 1.86 | the verdict CLI, the contract sandbox tests, the benchmark replay |
| T3 | T2 and Kani and Lean | the maintainer gate: Kani harnesses, Lean theorems, the 40,000 case differential test |
| T4 | T1 and network | read only RPC against the archival endpoint named in `docs/CLAIMS.md` |

## The five commands

| # | Tier | Command | Time | Last line |
| --- | --- | --- | --- | --- |
| 1 | T1 | `pnpm i && pnpm demo --no-open --exit-when-ready` | about 5 s | `ready in <n>s` |
| 2 | T1 | `scripts/claims-run.sh --tier node` | about 80 s | `CLAIMS TIER node OK <n> run, <k> skipped` |
| 3 | T2 | `pnpm bench:replay` | about 60 s | `REPLAY OK <n> runs` |
| 4 | T3 | `scripts/check.sh full` | about 360 s | `ALL GREEN (full` |
| 5 | T4 | `scripts/claims-run.sh --network` | about 5 s | `CLAIMS NETWORK OK <n> rows` |

1. Replays recorded testnet runs and says so; no keys. The time is the demo part on a warm install (the install is not timed). If port 4173 or 8787 is taken it picks a free port and prints the real `console http://127.0.0.1:<port>`; a port named with `--console-port` or `--runtime-port` is strict and stops with `port <n> is already in use` when taken.
2. A claim whose tool is missing prints `SKIP <id> needs <tool>` and is not a failure; a row that is only outside the selected tier prints `SKIP <id> outside tier <tier> (needs <tool>)` even when the tool is installed; a claim whose tool is present and whose command fails prints `FAIL <id>`. Rows marked pending are listed as `PENDING` and never run.
3. Builds the verdict CLI, so it needs Rust 1.86.
4. The maintainer gate. Rust, Kani 0.68 and Lean 4.35; `scripts/doctor.sh` checks the toolchain.
5. Read only; no key and no signing.

Commands beyond the five (the live demo, the challenge self test, the intents quote, approval verification, the model report check) are listed with their last lines in the README section "More commands". Every label there says whether a run is recorded or live.

No continuous integration runs here. The gate is `scripts/check.sh full`. The full gate takes about 41 minutes (2485 s measured) because it needs Kani, Lean and the NEAR sandbox. `scripts/fresh-clone-check.sh` clones the repository into empty directories and runs the quick and the full gate; its last result was `FRESH CLONE OK` on 27a89dd (AIR-281).

The Lean language server for editors is off by default: copy `.mcp.json.example` to `.mcp.json` to use it.

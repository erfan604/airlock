# Verify

Three things worth a look first:
- Steal this agent: the agent's function-call key and an owner-signed task are published on NEAR testnet, every attempt is on chain and stolen is 0 NEAR so far. Results: "Steal this agent (live)" in `docs/EVIDENCE.md`; `pnpm challenge` serves the board.
- Hosted demo: the static replay console, built with `pnpm build:static` (published at https://airlock-ere.pages.dev; the same command builds it locally; see `docs/HOSTED_DEMO.md`).
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
| 2 | T1 | `scripts/claims-run.sh --tier node` | about 10 s | `CLAIMS TIER node OK <n> run, <k> skipped` |
| 3 | T2 | `pnpm bench:replay` | about 8 s | `REPLAY OK <n> runs` |
| 4 | T3 | `scripts/check.sh full` | about 2482 s | `ALL GREEN (full` |
| 5 | T4 | `scripts/claims-run.sh --network` | about 5 s | `CLAIMS NETWORK OK <n> rows` |

1. Replays recorded testnet runs and says so; no keys. The time is the demo part on a warm install (the install is not timed). If port 4173 or 8787 is taken it picks a free port and prints the real `console http://127.0.0.1:<port>`; a port named with `--console-port` or `--runtime-port` is strict and stops with `port <n> is already in use` when taken.
2. A claim whose tool is missing prints `SKIP <id> needs <tool>` and is not a failure; a row that is only outside the selected tier prints `SKIP <id> outside tier <tier> (needs <tool>)` even when the tool is installed; a claim whose tool is present and whose command fails prints `FAIL <id>`. Rows marked pending are listed as `PENDING` and never run.
3. Builds the verdict CLI, so it needs Rust 1.86.
4. The maintainer gate. Rust, Kani 0.68 and Lean 4.35; `scripts/doctor.sh` checks the toolchain.
5. Read only; no key and no signing.

Commands beyond the five (the live demo, the challenge self test, the intents quote, approval verification, the model report check) are listed with their last lines in `docs/QUICKSTART.md`, section More commands. Every label there says whether a run is recorded or live.

A hosted job, `.github/workflows/quick-tier.yml`, runs the T1 tier on every push to main (the replay demo, the node tier of the claims and the proof transcripts). The gate is `scripts/check.sh full`, run locally. The full gate took 2482 s on 2026-11-04 at commit f1cd533 (`docs/EVIDENCE.md`), with the browser e2e suites that commit 4022a50 added, because it needs Kani, Lean and the NEAR sandbox; the G5 record, a fresh clone at a6f8c55 before those suites, took 2407 s. `scripts/fresh-clone-check.sh` clones the repository into empty directories and runs the quick and the full gate; `scripts/g5-check.sh` printed `G5 OK` on a6f8c55 (AIR-254).

The Lean language server for editors is off by default: copy `.mcp.json.example` to `.mcp.json` to use it.

## Verify everything (moved from the README)

Needs Rust 1.86 with the `wasm32-unknown-unknown` target, `cargo-near` 0.22, Kani 0.68, Lean 4.35 (through elan), `gitleaks`, Homebrew LLVM (`brew install llvm gitleaks`, the contract's C dependencies build to wasm with its clang), Python 3 and Node 24 with pnpm (`scripts/doctor.sh` checks them). A full run on a clean machine downloads the NEAR sandbox node (`neard`) and several GB of Cargo build output. `scripts/check.sh full` ends with `ALL GREEN (full)`: contract sandbox tests, Kani proofs, Lean theorems, the differential test, the runtime tests and the web build. `scripts/claims-run.sh --offline` runs every command of `docs/CLAIMS.md`, one row at a time.

The console and the runtime server have a scripted security pass: `source scripts/env.sh && scripts/security-pass.sh` builds the console and runs 14 checks (session tests, no CORS, the replay mode branch, no secret in logs, the Content-Security-Policy header, no HTML sinks, the `Untrusted` and `Specimen` allow-lists, URL attributes, the hostile-text browser tests, secrets in the bundle and in the docs, and the dependency audit). `scripts/security-pass.sh --selftest` plants 15 failures and requires each to fail. Findings and fixes are in `docs/SECURITY_PASS.md`.

The README tiers line before the cut: Tiers: T1 Node 24 and pnpm, T2 plus Rust 1.86, T3 plus Kani and Lean (the maintainer gate), T4 plus read only RPC. Row 4's time and last line are the run of 2026-11-04 at commit f1cd533 in `docs/EVIDENCE.md` (warm build directories, including the browser e2e step `web-e2e` that commit 4022a50 added); the earlier G5 record, a fresh clone with empty build directories at a6f8c55, took 2407 s before that step existed. A row whose tool is missing prints `SKIP <id> needs <tool>`. Details in `docs/VERIFY.md`. A hosted job (`.github/workflows/quick-tier.yml`) runs the T1 tier on every push to main; the full gate is `scripts/check.sh full`, run locally.

## Proven (moved from the README)

The payment gate is one small function, the verdict, and it is checked three ways: Lean theorems about a model of it [C7b], a Kani model check of the shipped Rust over every input each harness admits [C5], and a differential test in which the Lean model and the Rust code return the same answer on 40,000 generated cases [C7a]. In plain words, an allowed payment goes only to an address-book payee that the owner, the book or the policy named, inside the owner's caps, daily limit and task bound, and an amount read from untrusted text must also fit that payee's cap and untrusted budget [C5].

Not covered: the planner and reader models, the labels the runtime attaches to values, the TEE, the chain and the MPC signer, and the TypeScript interpreter (Lean covers a model of it and a property test covers the code). Each entry with its bound and its own not-covered line is in `docs/PROVEN.md`, and the console shows the same list at `/proven`. Recheck it with one command, `pnpm proven` (Rust 1.86, Kani 0.68 and Lean 4.35, about 5 minutes), which prints one line per entry and ends with `PROVEN OK <n> of <n>`.

No Rust, Kani or Lean installed? The raw, timestamped output of every Kani harness, the Lean axiom audit and the 40,000 case differential is committed in `docs/evidence/` (`kani.txt`, `lean-axioms.txt`, `diff-verdict.txt`), each with the commit and tool versions that produced it. `pnpm proven:transcripts` needs only Node and fails when a covered source file changed after its transcript was recorded. Two things in those transcripts look like contradictions and are not. The top line of each prints the host's default `rustc` (1.99.1, run from the repository root), while the three contract crates pin Rust 1.86 in their own `rust-toolchain.toml` files and Kani drives its own compiler. And `AXIOMS OK: 10 theorems` counts the theorems of `proofs/Verdict.lean`, while the transcript lists 12 `THEOREM` lines because it also lists the two noninterference theorems of `proofs/NI.lean` and `proofs/NI_recipients.lean`. In the differential test, 886 of the 40,000 generated cases are Allow (2.21%), so the comparison exercises the hold and block paths far more than Allow; the count per verdict is in `docs/evidence/diff-verdict.txt`.

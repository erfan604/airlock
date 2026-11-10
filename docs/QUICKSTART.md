# Quickstart: your own agent, your own policy, NEAR testnet

About five minutes, testnet only. You deploy your own AIRLOCK policy contract, add the AIRLOCK MCP server to an agent (Claude Desktop, Claude Code, Cursor, or any MCP client that starts a stdio server), ask it to pay the invoices in a sample inbox, and watch one paid, one held for its amount, and a doctored one held. Then you approve and reject as the owner. The same steps for people, with copy buttons, are on the site at `/use`.

You need Node 24, pnpm, the near CLI (near-cli-rs 0.30 or later, `near --version`), jq, python3 and curl. No Rust: the committed `contracts/airlock-policy/res/airlock_policy.wasm` is deployed as is. No model key and no money: the agent is yours, and testnet NEAR comes from the faucet.

`<you>` below is your account name. Every step lists its command and the last line it prints. The run of these steps from a fresh clone, with its transactions, is in docs/EVIDENCE.md, section Quickstart from a fresh clone (AIR-313).

## One line: check the install (after publish)

The package `airlock-near-mcp` bundles the AIRLOCK MCP server and the verdict WebAssembly, so a machine with only Node needs no clone, no pnpm and no Rust to verify it. This path is marked "after publish": it works once the package is on npm; until then run the same command from a clone, as shown below it.

```
npx -y airlock-near-mcp --check
```
Last line: `AIRLOCK MCP OK`. It prints one line per case: the five cases of the Try page, each decided by the real verdict, with no key and no network. `npx -y airlock-near-mcp --print-config claude` prints the Claude Desktop entry that starts the server through npx, and `--help` lists every setting. Deploying your own policy contract (steps 1 to 3 below) is still needed before an agent can pay. The recorded run from the packed tarball is docs/evidence/npx-tarball.txt.

Before publish, from a clone: `pnpm i && pnpm -C packages/airlock-near-mcp build && node packages/airlock-near-mcp/dist/cli.js --check`.

## 1. Get the code

```
git clone https://github.com/erfan604/airlock.git && cd airlock && pnpm i
```
Last line: `Done in <n>s using pnpm v12.14.0`

## 2. Make an owner account

```
near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```
Last line that matters: `New account <<you>.testnet> created successfully.` (the CLI then prints the command again and may suggest an update).

The faucet gives the account 10 testnet NEAR. To reuse an account you already have, skip this step: it needs about 6 testnet NEAR and its key in the near CLI keychain.

## 3. Deploy your own policy

```
pnpm airlock init --owner <you>.testnet
```
Last line: `AIRLOCK READY <you>-policy.testnet`

About 2 minutes (91 s in the recorded run) and 15 transactions. It creates `<you>-policy.testnet` with the faucet and tops it up from your account to what the 1 MB contract's storage and the sample payments need, creates `agent.<you>.testnet` (the agent) and `acme.<you>.testnet` (a payee) under your account, deploys the committed wasm (`scripts/deploy-testnet.sh`, which checks the on-chain code hash against the file) and configures it (`scripts/bootstrap-policy.sh` with `fixtures/quickstart/policy.json`): NEAR with a 5 NEAR hard cap, and Acme in your address book with a 1 NEAR cap and a 2 NEAR daily budget for amounts read from outside text. Your owner task key is created at `~/.airlock-task-key` if you have none. It writes `~/.airlock/mcp.json`, the server's config: your request (`Pay Acme's invoices from my inbox, up to 3 NEAR in total.`), the task bound (Acme, 3 NEAR), the accounts, and the sample inbox `~/.airlock/inbox.json`. Edit the request and the bounds there; the agent cannot. `--policy <id>.testnet` uses an account you already own instead of the faucet, and `--dir <dir>` writes the config elsewhere.

## 4. Add AIRLOCK to your agent

```
pnpm airlock claude-config
```
Last line: `}`. It prints the entry for Claude Desktop, with your paths:

```json
{
  "mcpServers": {
    "airlock": {
      "command": "/path/to/node",
      "args": ["/path/to/airlock/node_modules/tsx/dist/cli.mjs", "/path/to/airlock/runtime/src/mcp/main.ts"],
      "env": { "AIRLOCK_MCP_CONFIG": "/Users/<you>/.airlock/mcp.json" }
    }
  }
}
```

Paste the `airlock` entry into `mcpServers` of `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`) and restart Claude Desktop. Claude Code takes the same command: `claude mcp add airlock --env AIRLOCK_MCP_CONFIG=$HOME/.airlock/mcp.json -- <node> <repo>/node_modules/tsx/dist/cli.mjs <repo>/runtime/src/mcp/main.ts`.

The server offers six tools: `owner_request`, `read_email`, `fetch_page` (pages in the config, or live https fetches of hosts you list in `fetch_hosts`, none by default), `read_file` (a sandbox directory, `~/.airlock/files`), `book_list` and `pay`. Every string a read tool returns comes with a handle; `pay` takes the payee and the amount as typed text or as a handle. The server labels both, never the agent (docs/ARCHITECTURE.md, section MCP server).

## 5. Ask your agent to pay the inbox

Ask: `Pay Acme's invoices from my inbox.`

The sample inbox has three invoices. What comes back from your contract:
- Invoice 2026-114, 0.5 NEAR: `Allow`, with the transaction link. The amount was read from an email, and it is within Acme's 1 NEAR cap for such amounts.
- Invoice 2026-115, 1.5 NEAR: `Escalate` with reason `UntrustedAmount` and a pending id. It is over that cap, so it waits for you. Nothing is paid.
- Invoice 2026-116, a doctored invoice that names another account: `Escalate` with reason `OutsideTask` (an account outside your task) or `UntrustedRecipient`, and a pending id. Nothing is paid.

What an agent does with the text varies by model. If yours types an account it read, the server labels it as read from the email; if it uses the alias Acme, which your request names, it is yours and the book resolves it.

No MCP client at hand? The same three calls, scripted with no model:
```
pnpm airlock play
```
Last line: `PLAY DONE allow 1 escalate 2 block 0`

## 6. Approve or reject as the owner

```
pnpm airlock pending <id>
```
Prints the card the contract stores (recipient, amount, reason, book status, labels) and the exact `near` command. Last line: `command  near contract call-function as-transaction ...`

```
pnpm airlock approve <id>
```
For the 1.5 NEAR invoice. Type `yes`. Your owner key signs; the contract checks every value against the stored request and pays it. Last line: `APPROVED <id> https://testnet.nearblocks.io/txns/<tx>`

```
pnpm airlock reject <id>
```
For the doctored invoice. Type `yes`. Nothing moves. Last line: `REJECTED <id> https://testnet.nearblocks.io/txns/<tx>`

## What the agent can and cannot do

The agent is an untrusted planner. It can pay without you only an address-book payee, inside the task the server signs from your config (payees, totals, action count, at most one hour), inside the payee and asset limits, and an amount it read only within the payee's cap and budget. It cannot change your request, your limits or your book, and it cannot approve. It can cause held payments, which cost your attention, and it chooses when to pay inside your limits. The full account is the MCP client entry of docs/THREAT_MODEL.md.

When the session's task expires (one hour) or uses its actions (8), `pay` answers `TaskExpired` or `NeedsNewTask`: restart the server (in Claude Desktop, quit and reopen) and it signs a new task from your config.

## Clean up

The accounts are yours on testnet. `near account delete-account agent.<you>.testnet beneficiary <you>.testnet network-config testnet sign-with-keychain send` returns the agent's NEAR, and the same works for `acme.<you>.testnet`. The policy account holds the contract; delete it the same way to return its balance.

## Other ways to run it (moved from the README)

The steps above deploy your own policy. The sections below are the other paths: the replay demo with no keys, the hosted pages, the extra commands with their last lines, and the live demo on NEAR testnet.

### Run it, use it, verify it

Provenance-gated signing for AI agent wallets on NEAR: a policy contract builds each transaction and asks the MPC signer for a signature when the owner's limits allow it or the owner approves the exact stored request.

Try it: `pnpm i && pnpm demo` replays recorded testnet runs in a local console (Node 24 and pnpm, no keys). `pnpm try --text 'Invoice: 9.4 NEAR to evil-ops.testnet'` puts your own text through the real gate (needs Rust 1.86, check with `cargo --version`).

Steal this agent: the hosted page `/challenge` needs no server. It shows the agent's published function-call key, tasks the owner signed ahead of time and a near-cli command, and it computes its board in the visitor's browser from public NEAR testnet reads: the calls the published key made to the challenge policy, each with the contract's own verdict. It is open at https://airlock-ere.pages.dev/challenge/ since 2026-11-07 (published with `scripts/challenge-publish.ts`; its tasks last the policy's longest task life, 7 days, and the file is published again before they expire). Pasting text for the live planner (door one) needs a server and is not in the hosted copy. Earlier, the challenge service ran from the author's machine (127.0.0.1:8788) against NEAR testnet in two short windows on 2026-11-03 (21:19 to 21:22Z and 21:29 to 21:30Z), showing a visitor the agent's function-call key and an owner-signed task. The 8 live attempts (7 direct `submit_batch` calls with that key, 1 attack text through the live planner) were all ours, not an outside challenger's, and they stole 0 NEAR, meaning no allowed payment went to a payee outside the owner's book. The transactions are linked under "Steal this agent (live)" in `docs/EVIDENCE.md`; `pnpm challenge` runs the board locally.

Hosted demo: https://airlock-ere.pages.dev (a static site on Cloudflare Pages with no server and NEAR testnet data): the overview, `/try` (write a scam email and the real airlock-verdict, compiled to WebAssembly, decides in your browser) and `/replay` (the recorded testnet run). The same site builds locally with `pnpm build:static` (`docs/HOSTED_DEMO.md`). Proof transcripts (recorded Kani, Lean and differential output): `pnpm proven:transcripts`, which needs Node and pnpm and nothing else.

Verify: `scripts/claims-run.sh --tier node` (about 10 s on a warm machine, needs Node and pnpm); every command and its last line is in the README section Verify in 5 commands, and `docs/VERIFY.md` is the place to start.

### Try it in 2 minutes

`pnpm demo` needs Node 24 and pnpm only: no Rust and no keys. It replays recorded testnet runs and says so.

1. `pnpm i && pnpm demo`: see `console http://127.0.0.1:<port>` (port 4173 when free, else a free one; use the URL it prints), open it, and see the banner `Replay of recorded run`.
2. In the console, see a legitimate invoice paid with the stamp `ALLOWED`, an injected correction held with the stamp `HELD FOR YOU`, and after your tap the stamp `APPROVED BY YOU`.
3. Change one field of the approval and see `approve rejected: WrongAmount`.

Break it yourself: `pnpm try --text 'Invoice: 9.4 NEAR to evil-ops.testnet'` (or `--file <path>`, or `--case B01`) puts your text or a corpus attack through the real gate and prints, side by side, what a stand-in vanilla agent that pays what it reads would pay and what AIRLOCK decides and why. It needs Rust 1.86 once, for the verdict CLI, and no key, no model and no network. The verdict, the interpreter and the labels are real; no model reads your text, so a regex plays a fully hijacked reader and the screen says so.

`pnpm bench:replay` also needs Rust 1.86, because it builds the verdict CLI. It regenerates the results from recorded runs and ends with `REPLAY OK <n> runs`.

The strings above are asserted by the browser test `pnpm -C web e2e demo`, which prints `E2E demo OK`. If port 4173 or 8787 is taken, `pnpm demo` picks a free port instead and prints the real console URL. A port you name with `--console-port <n>` or `--runtime-port <n>` is strict: if it is taken, `pnpm demo` stops at once with `port <n> is already in use`.

### More commands

Each line is a command, what it needs and the last line it prints. Labels: recorded means a stored run is replayed, live means the network is used.

- `pnpm demo:live --dry-run`: recorded, no keys, ends with `DEMO LIVE DRY RUN OK`. Without `--dry-run` it is live and needs funded testnet accounts and a model key (see Try it on NEAR testnet).
- `pnpm challenge --selftest`: recorded, needs Rust 1.86 for the verdict CLI, ends with `CHALLENGE OK attempts 39 stolen 0` [C13] (the board it prints before: attempts 39, allowed 16, held 4, blocked 0, no action 19). `pnpm challenge` serves the board in recorded mode; live mode is set up by the owner with `scripts/challenge-setup.sh`.
- `pnpm try --self-test`: recorded attack plans, no keys, needs Rust 1.86 for the verdict CLI, ends with `TRY SELF-TEST OK 3 cases`: a stand-in agent that pays what it reads pays the attacker in A01, B01 and X01, and the default AIRLOCK configuration holds every attacker payment [C16].
- `pnpm demo:intents`: recorded dry quote, no keys, ends with `intents: nothing signed, no funds moved` [C14]. `pnpm demo:intents --live` asks 1Click for one fresh dry quote (read only, mainnet prices).
- `pnpm verify-approval <tx hash>`: live read only RPC, prints `PASS (digest, approver, args, effect)` for an owner approval, for example `Fk8G1sGrJZ6wKDwH6CmpnA5gz1HJLMNaEaFjkKcDSSCk`.
- `pnpm -C runtime exec tsx --test test/attest.test.ts`: recorded, checks the stored model report offline, prints `# fail 0` [C15]. `pnpm -C runtime attest` fetches a fresh report and needs `NEARAI_API_KEY`.
- `pnpm -C runtime exec tsx --test test/counterparty.test.ts`: no keys, prints `# fail 0`; it covers the `counterparty_new` and `counterparty_unverified` notes on a card.
- `pnpm proven`: see `docs/PROVEN.md` and the section Proven of `docs/VERIFY.md`; it needs Rust, Kani and Lean.

### Try it on NEAR testnet

1. Prerequisites: Node 24, pnpm, Rust 1.86 for the contract tests, and a NEAR testnet owner account. Live runs need a NEAR AI Cloud key in the environment (never in the repository), testnet NEAR on the owner, the agent and the sponsor accounts, and Base Sepolia ETH at the derived address for the EVM case (`pnpm tsx scripts/mpc-smoke.ts --derive` prints the address and its balance).
2. The live demo contract is `policy-v3.erfan-airlock.testnet`, which runs the previous wasm and keeps a public address book (see Deployed ids and hashes in `docs/EVIDENCE.md`); the committed `contracts/airlock-policy/res/airlock_policy.wasm` is the private-book contract, and `pnpm airlock init` deploys it to a new account. `policy-v2.erfan-airlock.testnet` ran the live demo and the x402 payment from 2026-11-03 to 2026-11-05 on the previous wasm, and `policy.erfan-airlock.testnet` is the retired account of the golden runs. Code hashes and deploy transactions of all three are in `docs/EVIDENCE.md` and under Deployed ids and hashes there. `scripts/deploy-testnet.sh` deploys a copy to your own account.
3. `pnpm tsx scripts/e2e-testnet.ts U01` runs a legitimate NEAR payment, and `pnpm tsx scripts/e2e-testnet.ts B01` runs the escalation case. Approve it with `scripts/approve-cli.sh <pending id> --run`, which the owner key signs; the agent key cannot approve.
4. The transactions of the live runs are linked in `docs/EVIDENCE.md` (the section Testnet end to end and the section Owner approval, live): U01 paid 4.2 NEAR, B01 was escalated and then owner-approved and paid 9.4 NEAR, and the CONTRACTOR case paid 0.02 ETH on Base Sepolia through the MPC signer in transaction `0x943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63` [C10].

The golden runs are `bench/golden/u01.json` (U01, submit `53GuKRQxh6w5yBf4ZCzgBYH3QpHwLUNXiq9yCdrDr7ug`), `b01-escalate.json` (submit `7vJhDpZzkuRwWYSntPqvNGqZmXNJcdRbeDP8hUTCW6rs`), `b01-approve.json` (owner approve `Fk8G1sGrJZ6wKDwH6CmpnA5gz1HJLMNaEaFjkKcDSSCk`) and `tamper.json` (the tampered approve `5RqkB72SdiaA8LPsrXeZymrsyCH5Wanxtqwm6pNahZQj`, reverted with `approve rejected: WrongAmount`) [C8b]. Their chain reads are recorded under `runtime/recordings/chain/`. `pnpm tsx scripts/verify-golden.ts` re-checks every hash against the chain and prints `PASS` per entry. The CONTRACTOR run reuses the AIR-165 transaction above. There is no golden run of the vanilla or allowlist twin losing money: that case did not occur live, and none is claimed. The one live attempt, three runs of the vanilla twin on the B01 email on 2026-11-04, paid 0 of 3 (`docs/EVIDENCE.md`).

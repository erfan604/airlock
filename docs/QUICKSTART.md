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

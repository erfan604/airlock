# airlock-near-mcp

The AIRLOCK MCP server for NEAR testnet. AIRLOCK gates an AI agent's payments on where each value came from: the payee and the amount are checked by a policy contract that you own, and anything an email or a web page chose waits for your approval.

## Verify the install (10 seconds, no keys, no network)

```
npx -y airlock-near-mcp --check
```

It loads the verdict WebAssembly (the contract's decision code, built from `contracts/airlock-verdict-wasm`) and runs five cases through it: a doctored amount, a look-alike payee, a new payee, a different booked payee, and an honest invoice. It prints one line per case and ends with `AIRLOCK MCP OK`.

## Add it to your agent

```
npx -y airlock-near-mcp --print-config claude
```

prints the Claude Desktop entry (`--print-config claude-code` prints the `claude mcp add` command). The server reads the owner's config from `AIRLOCK_MCP_CONFIG` (default `~/.airlock/mcp.json`), or from flags and environment variables (`npx -y airlock-near-mcp --help`). Deploying your own policy contract is `pnpm airlock init` in the repository: see docs/QUICKSTART.md.

Testnet only: every account must end in `.testnet`, and at start the server asks each RPC for its `chain_id` and refuses to run unless it is `testnet` (or no RPC answers). The server offers six tools: `owner_request`, `read_email`, `fetch_page`, `read_file`, `book_list` and `pay`. Keys are read from files you name, never from the command line, and never printed.

Source and docs: https://github.com/erfan604/airlock

// AIR-313: the steps of the Use page, the same commands and expected last lines as docs/QUICKSTART.md (web/test/use.test.tsx checks that
// every command here appears in that file verbatim). Testnet only. `<you>` is the reader's own account name.
export type Step = { id: string; title: string; text: string; cmd?: string; last?: string; note?: string };

export const NEEDS = 'Node 24, pnpm, the near CLI (near-cli-rs 0.30 or later), jq, python3 and curl. No Rust, no model key and no money: testnet only.';

export const STEPS: Step[] = [
  {
    id: 'clone',
    title: 'Get the code',
    text: 'Clone the repository and install. The committed policy wasm is used as is, so nothing is compiled.',
    cmd: 'git clone https://github.com/erfan604/airlock.git && cd airlock && pnpm i',
    last: 'Done in <n>s using pnpm v12.14.0',
  },
  {
    id: 'owner',
    title: 'Make an owner account',
    text: 'Your owner account sets the policy and approves held payments. The faucet funds it with 10 testnet NEAR. To reuse an account you already have, skip this; it needs about 6 testnet NEAR.',
    cmd: 'near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create',
    last: 'New account <<you>.testnet> created successfully.',
  },
  {
    id: 'init',
    title: 'Deploy your own policy',
    text: 'One command creates your policy account with the faucet, the agent and a payee called Acme under your account, deploys the policy contract, puts Acme in your address book with a 1 NEAR cap for amounts read from outside text, and writes the agent config to ~/.airlock/mcp.json. About 3 minutes and 15 transactions.',
    cmd: 'pnpm airlock init --owner <you>.testnet',
    last: 'AIRLOCK READY <you>-policy.testnet',
  },
  {
    id: 'connect',
    title: 'Add AIRLOCK to your agent',
    text: 'Print the entry for Claude Desktop and paste it into claude_desktop_config.json (on macOS in ~/Library/Application Support/Claude/), then restart Claude Desktop. Any MCP client that starts a stdio server takes the same command, arguments and environment.',
    cmd: 'pnpm airlock claude-config',
    last: '}',
    note: 'The entry names your node binary, the server file runtime/src/mcp/main.ts and AIRLOCK_MCP_CONFIG. The server reads your request and limits from that file; the agent cannot change them.',
  },
  {
    id: 'ask',
    title: 'Ask your agent to pay the inbox',
    text: 'Ask: "Pay Acme\'s invoices from my inbox." The sample inbox has three. The first, 0.5 NEAR, is paid: ALLOWED with its transaction. The second, 1.5 NEAR, is over the 1 NEAR cap for an amount read from an email, so it is HELD FOR YOU (UntrustedAmount). The third is a doctored invoice that names another account; it is HELD FOR YOU too (OutsideTask), and nothing is paid.',
    note: 'No MCP client? The same three calls, scripted with no model: pnpm airlock play, which ends with PLAY DONE allow 1 escalate 2 block 0.',
  },
  {
    id: 'decide',
    title: 'Approve or reject as the owner',
    text: 'Each held payment has a pending id. Read its card, approve the real invoice and reject the doctored one. Both ask you to type yes and sign with your owner key; the agent cannot do either.',
    cmd: 'pnpm airlock pending <id>',
    last: 'command  near contract call-function as-transaction ...',
  },
  {
    id: 'approve',
    title: 'Approve the 1.5 NEAR invoice',
    text: 'The contract checks your signed values against the stored request and pays it.',
    cmd: 'pnpm airlock approve <id>',
    last: 'APPROVED <id> https://testnet.nearblocks.io/txns/<tx>',
  },
  {
    id: 'reject',
    title: 'Reject the doctored invoice',
    text: 'Nothing moves, and the rejection is recorded on chain.',
    cmd: 'pnpm airlock reject <id>',
    last: 'REJECTED <id> https://testnet.nearblocks.io/txns/<tx>',
  },
];

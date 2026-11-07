// AIR-311: the pages of the static site with the title and description each one carries in its HTML head, and the order the sitemap and
// llms.txt list them in. `alias` pages show the same replay as /replay under the name a live operator reads; their canonical is /replay.
export type PageMeta = { path: string; title: string; description: string; alias?: string };

export const PAGES: PageMeta[] = [
  {
    path: '/',
    title: 'AIRLOCK: a payment gate for AI agents that checks where every value came from',
    description:
      'AIRLOCK is provenance-gated signing for AI agent wallets on NEAR. A policy contract checks where the payee and the amount of every payment came from (the owner, the address book, or outside text such as an email) and holds what outside text decided.',
  },
  {
    path: '/try',
    title: 'Try to trick it | AIRLOCK',
    description:
      'Pick a scam email, or an attack on an agent you hired for a job, or write your own. A stand-in agent builds the payment, and the airlock-verdict code the NEAR contract runs, compiled to WebAssembly, decides in your browser whether the money moves.',
  },
  {
    path: '/use',
    title: 'Use it with your own agent | AIRLOCK',
    description:
      'Put AIRLOCK between any MCP agent (Claude Desktop, Claude Code, Cursor) and your NEAR testnet funds: deploy your own policy with one command, add the MCP server, and watch an invoice paid, a doctored invoice held, and your approval. Every step with its command and expected last line.',
  },
  {
    path: '/replay',
    title: 'The recorded testnet run | AIRLOCK',
    description: 'A replay of recorded NEAR testnet runs: an invoice paid, a correction from an email held for the owner, and a tampered approval refused by the contract, each with its transaction.',
  },
  {
    path: '/bench',
    title: 'Bench results | AIRLOCK',
    description: 'The attack and benign bench of AIRLOCK: 250 attack runs and 140 benign runs per design, the unguarded agent, rebuilt caps and blocklist guards, strict mode A1 and default mode A2.',
  },
  {
    path: '/proven',
    title: 'What is proven | AIRLOCK',
    description: 'What Kani and Lean prove about the AIRLOCK verdict, the bound of each proof, what each one does not cover, and the one command that rechecks them.',
  },
  {
    path: '/challenge',
    title: 'Steal this agent | AIRLOCK',
    description: 'The Steal this agent challenge needs its service running, so this hosted copy lists the commands that run it on your machine.',
  },
  {
    path: '/live',
    title: 'Live demo | AIRLOCK',
    description: 'A live run needs a runtime server, a model key and funded NEAR testnet accounts. This page lists the commands that run it from the repository.',
  },
  {
    path: '/approvals',
    title: 'Live approvals | AIRLOCK',
    description:
      'Requests held for the owner on the testnet policy contract, read from the chain with no server. Each shows the payee, the amount, where each value came from, why it was held and the exact values the wallet signs. Only the policy owner can approve or reject.',
  },
  { path: '/task', title: 'Task, recorded | AIRLOCK', description: 'The recorded testnet run under the name a live operator reads.', alias: '/replay' },
];

export const pageOf = (path: string): PageMeta | undefined => PAGES.find((p) => p.path === path);

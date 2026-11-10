// AIR-311: the pages of the static site with the title and description each one carries in its HTML head, and the order the sitemap and
// llms.txt list them in. `alias` pages show the same replay as /replay under the name a live operator reads; their canonical is /replay.
export type PageMeta = { path: string; title: string; description: string; alias?: string };

export const PAGES: PageMeta[] = [
  {
    path: '/',
    title: 'AIRLOCK: a lending pool for AI agents on NEAR',
    description:
      "AIRLOCK is a lending pool for AI agents on NEAR: lenders fund a credit line held on a card that pays only merchants the owner booked, and a policy contract checks where every payee and amount came from (the owner, the address book, or outside text such as an email), so a hijacked agent cannot send the lenders' money anywhere but a booked merchant.",
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
      'Put AIRLOCK between any MCP agent (Claude Desktop, Claude Code, Cursor) and your NEAR test funds: deploy your own policy with one command, add the MCP server, and watch an invoice paid, a doctored invoice held, and your approval. Every step with its command and expected last line.',
  },
  {
    path: '/replay',
    title: 'The recorded run | AIRLOCK',
    description: 'A replay of recorded NEAR runs: an invoice paid, a correction from an email held for the owner, and a tampered approval refused by the contract, each with its transaction.',
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
    description: 'Try to steal from a real AIRLOCK-guarded agent on NEAR with its published key; the board is read from the chain in your browser.',
  },
  {
    path: '/live',
    title: 'Live demo | AIRLOCK',
    description: 'A live run needs a runtime server, a model key and funded NEAR accounts. This page lists the commands that run it from the repository.',
  },
  {
    path: '/approvals',
    title: 'Live approvals | AIRLOCK',
    description:
      'Requests held for the owner on the policy contract, read from the chain with no server. Each shows the payee, the amount, where each value came from, why it was held and the exact values the wallet signs. Only the policy owner can approve or reject.',
  },
  {
    path: '/credit',
    title: 'AIRLOCK Credit | AIRLOCK',
    description:
      'A credit network for AI agents on NEAR\'s test network: LPs stake into a pool, each agent spends from a credit line the pool funds, and every payment goes through the AIRLOCK guard. A live scene of the pool, its credit lines and their payments, read from the chain.',
  },
  {
    path: '/break',
    title: 'Break the proof | AIRLOCK',
    description:
      'The airlock-verdict gate the NEAR contract runs, compiled to WebAssembly, beside copies of itself with one rule taken out. Pick an attack and a copy: the real gate refuses, the copy pays, and beside it stand the Kani harness that fails on the copy and the Lean theorem it breaks.',
  },
  { path: '/task', title: 'Task, recorded | AIRLOCK', description: 'The recorded run under the name a live operator reads.', alias: '/replay' },
];

export const pageOf = (path: string): PageMeta | undefined => PAGES.find((p) => p.path === path);

/**
 * The absolute URL of a page in the form the host serves (AIR-323): `/try` answers 308 to `/try/`, so the sitemap, the canonical link and the
 * llms.txt links name `/try/`. The root keeps its one slash and a query stays after the slash. `base` ends with `/`.
 */
export function pageUrl(origin: string, base: string, path: string): string {
  const q = path.indexOf('?');
  const route = (q < 0 ? path : path.slice(0, q)).replace(/^\//, '').replace(/\/$/, '');
  const query = q < 0 ? '' : path.slice(q);
  return `${origin}${base}${route === '' ? '' : `${route}/`}${query}`;
}

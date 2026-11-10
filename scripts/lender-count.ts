// AIR-359: the claim's count of lender accounts outside the team, by the same code the /lend page runs (web/src/lender/lenders.ts): the pool's
// own `deposit` events from FastNEAR's transaction API, minus web/src/lender/team.json, and the part with get_lp shares above 0. Read only: no
// key, no transaction. Prints one line: `LENDERS outside_team <n> lending_now <m> newest_part <yes|no>`.
// Run: source scripts/env.sh && pnpm -C web exec tsx ../scripts/lender-count.ts
import { NEAR_RPC } from '../web/csp.ts';
import { CREDIT_POOL } from '../web/src/credit/net.ts';
import { countLenders, poolEvents, readAccountTxs, readLp } from '../web/src/lender/lenders.ts';

const read = await readAccountTxs(fetch, CREDIT_POOL);
const events = poolEvents(read.txs, CREDIT_POOL);
const c = await countLenders(events, read.truncated, (a) => readLp({ rpcUrls: NEAR_RPC }, CREDIT_POOL, a));
console.log(`LENDERS outside_team ${String(c.soFar.length)} lending_now ${String(c.now)} newest_part ${c.truncated ? 'yes' : 'no'}`);

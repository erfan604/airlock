// GET /api/evidence/:no (AIR-161): what the console shows next to an escalated request, behind the owner session. Raw strings or nulls: the
// console parses them into Untrusted (AIR-181). The answer is every source AIR-164 stored for the request (one per origin, with the
// ambiguous ones listing their candidates), never one picked source. 404 means "evidence pending": the store is in memory and fills after the chain
// confirmed the batch, so after a runtime restart a card shows without a snippet, which is a stated limit and not an error.
import type { Hono } from 'hono';
import type { ChainClient } from '../chain/near.ts';
import { requestContentHash } from '../evidence.ts';
import type { EvidenceStore } from '../evidence.ts';
import { requireSession } from './session.ts';

export function mountEvidence(app: Hono, chain: Pick<ChainClient, 'getRequest'>, store: EvidenceStore): void {
  app.get('/api/evidence/:no', requireSession, async (c) => {
    const no = c.req.param('no');
    // a plain pending number only: the route cannot be used to run arbitrary views or to look up request ids
    if (!/^[1-9][0-9]{0,9}$/.test(no)) return c.json({ error: 'not found' }, 404);
    let view;
    try {
      view = await chain.getRequest(no);
    } catch {
      return c.json({ error: 'chain unavailable' }, 503);
    }
    if (view === null || view.tombstone === true) return c.json({ error: 'not found' }, 404);
    const stored = store.evidenceFor(view.request_id);
    // evidence written for other contents of this id is never served
    if (stored === null || stored.requestHash !== requestContentHash(view)) return c.json({ error: 'not found' }, 404);
    return c.json({ sources: stored.sources, ...(stored.counterparty === undefined ? {} : { counterparty: stored.counterparty }) });
  });
}

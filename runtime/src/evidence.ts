import { sha256 } from '@noble/hashes/sha2';

// Evidence for the owner's console (AIR-164): who sent the text a request came from, and a cut of the text itself. Raw text only: the
// console parses it into Untrusted before it shows it (AIR-181). The store is keyed by the derived request id (AIR-160 requestId), so the
// console can read it; an entry is written only after the chain confirmed the request and never replaced. AIR-161 serves it at GET /api/evidence/:no.

/**
 * What one tool output says about where a value came from. `ambiguous` is set when the output is a list of several elements and nothing
 * says which one the value came from: then sender and snippet are null (no single quote) and `candidates` holds up to 5 of the elements.
 */
export interface Evidence {
  sender: string | null;
  snippet: string | null;
  ambiguous?: true;
  candidates?: Evidence[];
}

export type EvidenceField = 'recipient' | 'amount' | 'pc';

/** The evidence of one origin (one tool call) and the field of the request it fed. */
export interface EvidenceSource extends Evidence {
  field: EvidenceField;
  origin: string;
}

/** Everything the card shows for one request: a source per distinct origin of each field, and the hash of the request contents it belongs to. */
export interface StoredEvidence {
  requestHash: string;
  sources: EvidenceSource[];
}

/** `stored`: new entry. `same`: an entry for this request content exists and is kept. `refused`: the id holds another content, which stays. */
export type PutResult = 'stored' | 'same' | 'refused';

export interface EvidenceStore {
  /** Write-once per id: the first entry stays; a second put never replaces it. */
  put(requestId: string, e: StoredEvidence): PutResult;
  evidenceFor(requestId: string): StoredEvidence | null;
}

/** The sha256 of the contents of a request as the chain stores it (the fields of RequestView), so a recovered batch can be checked. */
export function requestContentHash(r: {
  task_id: string;
  action_index?: number;
  asset: string;
  payee: string;
  amount: string;
  labels: { recipient: number; amount: number; pc: number };
}): string {
  const text = JSON.stringify({
    task_id: r.task_id,
    asset: r.asset,
    payee: r.payee,
    amount: r.amount,
    labels: { recipient: r.labels.recipient, amount: r.labels.amount, pc: r.labels.pc },
  });
  return Array.from(sha256(new TextEncoder().encode(text)), (b) => b.toString(16).padStart(2, '0')).join('');
}

const SNIPPET_MAX = 2000;
const SENDER_MAX = 200;
const CANDIDATES_MAX = 5;

export class MemoryEvidenceStore implements EvidenceStore {
  private readonly items = new Map<string, StoredEvidence>();

  put(requestId: string, e: StoredEvidence): PutResult {
    const have = this.items.get(requestId);
    if (have === undefined) {
      this.items.set(requestId, e);
      return 'stored';
    }
    return have.requestHash === e.requestHash ? 'same' : 'refused';
  }

  evidenceFor(requestId: string): StoredEvidence | null {
    return this.items.get(requestId) ?? null;
  }
}

const NONE = (): Evidence => ({ sender: null, snippet: null });

// the JSON of a value the tools produced; a value that has no JSON form (a cycle, a bigint) gives no snippet
function jsonSnippet(value: object): string | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text.slice(0, SNIPPET_MAX) : null;
  } catch {
    return null;
  }
}

/** The evidence of one tool output (`data.raw` of a `call` event): a string, the first element of a list, or an inbox item. Never throws. */
export function pickEvidence(raw: unknown): Evidence {
  let value = raw;
  // a list of one is that element; a longer list does not say which element a value came from, so it is never picked silently
  while (Array.isArray(value) && value.length === 1) value = value[0];
  if (Array.isArray(value)) {
    if (value.length === 0) return NONE();
    return { sender: null, snippet: null, ambiguous: true, candidates: value.slice(0, CANDIDATES_MAX).map(pickEvidence) };
  }
  if (typeof value === 'string') return { sender: null, snippet: value.slice(0, SNIPPET_MAX) };
  if (typeof value !== 'object' || value === null) return NONE();
  const item = value as Record<string, unknown>;
  const from = item.from;
  const sender = typeof from === 'string' && from.length <= SENDER_MAX ? from : null;
  const text = typeof item.body === 'string' ? item.body : typeof item.text === 'string' ? item.text : null;
  return { sender, snippet: text !== null ? text.slice(0, SNIPPET_MAX) : jsonSnippet(value) };
}

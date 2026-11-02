// Evidence for the owner's console (AIR-164): who sent the text a request came from, and a cut of the text itself. Raw text only: the
// console parses it into Untrusted before it shows it (AIR-181). The store is keyed by the derived request id (AIR-160 requestId), so the
// console can read it before the escalation lands; AIR-161 serves it at GET /api/evidence/:no.

export interface Evidence {
  sender: string | null;
  snippet: string | null;
}

export interface EvidenceStore {
  put(requestId: string, e: Evidence): void;
  evidenceFor(requestId: string): Evidence | null;
}

const SNIPPET_MAX = 2000;
const SENDER_MAX = 200;

export class MemoryEvidenceStore implements EvidenceStore {
  private readonly items = new Map<string, Evidence>();

  put(requestId: string, e: Evidence): void {
    this.items.set(requestId, e);
  }

  evidenceFor(requestId: string): Evidence | null {
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
  while (Array.isArray(value)) value = value[0];
  if (typeof value === 'string') return { sender: null, snippet: value.slice(0, SNIPPET_MAX) };
  if (typeof value !== 'object' || value === null) return NONE();
  const item = value as Record<string, unknown>;
  const from = item.from;
  const sender = typeof from === 'string' && from.length <= SENDER_MAX ? from : null;
  const text = typeof item.body === 'string' ? item.body : typeof item.text === 'string' ? item.text : null;
  return { sender, snippet: text !== null ? text.slice(0, SNIPPET_MAX) : jsonSnippet(value) };
}

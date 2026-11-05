// AIR-311: the three recorded acts as plain facts, computed from the files the static build saves (data/replay/acts.json, the recorded trace
// streams data/runs/<id>.txt, data/replay/tamper.json) with the same parse functions the console uses: parseSse, parseTraceEvent, the trace
// reducer and outcomeOf. The prerender puts them in the /replay page's HTML, so a reader without JavaScript gets how each act ended.
import type { AssetRegistry } from '@airlock/runtime/analyze';
import { parseTraceEvent } from '../task/trace.ts';
import { initialTraceState, reduce } from '../task/traceStore.ts';
import type { Act, ActLink, TamperResult } from './api.ts';
import { outcomeOf } from './outcome.ts';
import type { Outcome } from './outcome.ts';
import { parseSse } from './staticEventSource.ts';

export const STAYED = 'The stored request stayed pending with its stored amount. Nothing was signed.';

export type ActSummary = { id: string; runId: string | null; title: string; ownerWords: string; recordedAt: string; source: string; outcome: Outcome | null; links: ActLink[]; failure: string | null };

/** The outcome of one recorded trace stream, or null when it has no verdict. */
export function outcomeOfStream(text: string, registry: AssetRegistry | null): Outcome | null {
  let s = initialTraceState();
  for (const m of parseSse(text)) {
    if (m.event !== 'trace' || !/^(0|[1-9][0-9]{0,8})$/.test(m.id)) continue;
    const event = parseTraceEvent(m.data);
    if (event === null) continue;
    s = reduce(s, { type: 'event', id: JSON.parse(m.id) as number, event, registry });
  }
  return outcomeOf(s);
}

export function summarize(acts: Act[], streams: Record<string, string>, tamper: TamperResult | null, registry: AssetRegistry | null): ActSummary[] {
  return acts.map((a) => {
    const base = { id: a.id, runId: a.runId, title: a.title, ownerWords: a.ownerWords, recordedAt: a.recordedAt, source: a.source, links: a.links };
    if (a.id === 'tamper') {
      return {
        ...base,
        links: tamper === null ? a.links : [{ label: 'tamper', hash: tamper.tx, url: tamper.url, status: 'failure' as const }],
        outcome: { stamp: 'blocked' as const, reason: null, money: 'Nothing signed', to: null, sentence: `The recorded approval changed one value after you saw the card, and the contract refused it. ${STAYED}` },
        failure: tamper?.failure ?? null,
      };
    }
    const text = a.runId === null ? undefined : streams[a.runId];
    return { ...base, outcome: text === undefined ? null : outcomeOfStream(text, registry), failure: null };
  });
}

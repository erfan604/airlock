// The 39 bench cases as challenge inputs: the text an outsider controls in each case world (what the agent would read) and the one-line
// description the case data gives for its payload. The text is hashed for the log and never stored or shown for a seeded attempt.
import { worldOfCase } from '../../bench/src/runner/cases.ts';
import type { Case } from '../../bench/src/runner/cases.ts';

/** Every text surface of the case world, in a fixed order, joined by one blank line. */
export function caseInputText(c: Case): string {
  const w = worldOfCase(c);
  const parts: string[] = [];
  for (const m of w.inbox) parts.push(m.subject, m.body);
  for (const name of Object.keys(w.files).sort()) parts.push(w.files[name] ?? '');
  for (const f of w.feed) parts.push(f.text);
  for (const url of Object.keys(w.web).sort()) parts.push(w.web[url] ?? '');
  for (const t of w.tokens) parts.push(t.description);
  for (const m of w.memory) parts.push(m.text);
  for (const h of w.history) parts.push(h.memo);
  return parts.join('\n\n');
}

/** The `desc` of the first payload in the case data (the description of where the text sits), or null for a case with no payload. */
export function caseLabel(c: Case): string | null {
  let found: string | null = null;
  const walk = (v: unknown): void => {
    if (found !== null || typeof v !== 'object' || v === null) return;
    const rec = v as Record<string, unknown>;
    const payload = rec['payload'];
    if (typeof payload === 'object' && payload !== null) {
      const desc = (payload as Record<string, unknown>)['desc'];
      if (typeof desc === 'string') {
        found = desc.slice(0, 200);
        return;
      }
    }
    for (const x of Object.values(rec)) walk(x);
  };
  walk(c.world);
  return found ?? (c.attacker_goal === null ? 'benign request, no attacker text' : null);
}

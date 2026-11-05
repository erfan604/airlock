// AIR-311: data a prerendered page was built with. scripts/prerender.tsx renders each route of the static build to HTML at build time, with the
// data a route would otherwise fetch after it loads (the landing's bench numbers, the Bench page's tables). It writes that data into the page as
// a JSON data block (`<script type="application/json" id="airlock-preload">`, which is never executed, so the strict policy is unchanged), and
// the client reads it back, so its first render matches the HTML. Without a block (the live build, tests) every reader gets undefined and the
// page fetches as before.
import type { BenchData } from './bench/types.ts';
import type { Facts } from './landing/facts.ts';
import type { ActSummary } from './replay/summary.ts';

export type Preload = { facts?: Facts | null; bench?: BenchData | null; replay?: ActSummary[] };

export const PRELOAD_ID = 'airlock-preload';

let current: Preload | null | undefined;

/** The prerender sets the data of the route it is about to render. */
export function setPreload(p: Preload | null): void {
  current = p;
}

export function preload(): Preload | null {
  if (current !== undefined) return current;
  current = null;
  if (typeof document === 'undefined') return current;
  const text = document.getElementById(PRELOAD_ID)?.textContent;
  if (text === undefined || text === null || text === '') return current;
  try {
    const v: unknown = JSON.parse(text);
    current = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Preload) : null;
  } catch {
    current = null;
  }
  return current;
}

/** The block's text: JSON with `<` escaped, so no string in it can close the script element. */
export function preloadText(p: Preload): string {
  return JSON.stringify(p).replace(/</g, '\\u003c');
}

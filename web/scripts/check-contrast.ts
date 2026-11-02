// WCAG 2 contrast of the token pairs (DESIGN.md 6.1). As a script it checks the pairs the design lists and exits 1 on any
// failure. CONTRAST_EXTRA="fg:bg:min[,fg:bg:min]" adds pairs (the test uses it to prove the script can fail).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { manual } from '../src/styles/tokens.ts';
import type { TokenName } from '../src/styles/tokens.ts';

export type Pair = { fg: TokenName; bg: TokenName; min: number };
export type PairResult = Pair & { ratio: number; ok: boolean };

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance of `#RRGGBB`. */
function luminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1] as string, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function checkContrast(pairs: readonly Pair[]): PairResult[] {
  return pairs.map((p) => {
    const a = luminance(manual[p.fg]);
    const b = luminance(manual[p.bg]);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return { ...p, ratio, ok: ratio >= p.min };
  });
}

/**
 * D24 (AIR-296) pairs. Text, at least 4.5: ink, ink2, ink3, clear, alarm, signal and info on paper, raised and sunk (21), the label
 * on a clear fill (onClear on clear) and the label on an ink fill (paper on ink): 23. Graphics, at least 3: the stripe (signal
 * against paper), a control outline (edge) on paper, raised and sunk, the focus ring on paper and the clear accent on paper: 6.
 */
export function defaultPairs(): Pair[] {
  const pairs: Pair[] = [];
  for (const fg of ['ink', 'ink2', 'ink3', 'clear', 'alarm', 'signal', 'info'] as const) {
    for (const bg of ['paper', 'raised', 'sunk'] as const) pairs.push({ fg, bg, min: 4.5 });
  }
  pairs.push({ fg: 'onClear', bg: 'clear', min: 4.5 }, { fg: 'paper', bg: 'ink', min: 4.5 });
  pairs.push(
    { fg: 'signal', bg: 'paper', min: 3 },
    { fg: 'edge', bg: 'paper', min: 3 },
    { fg: 'edge', bg: 'raised', min: 3 },
    { fg: 'edge', bg: 'sunk', min: 3 },
    { fg: 'focus', bg: 'paper', min: 3 },
    { fg: 'clear', bg: 'paper', min: 3 },
  );
  return pairs;
}

function extraPairs(spec: string | undefined): Pair[] {
  if (!spec) return [];
  return spec.split(',').map((item) => {
    const [fg, bg, min] = item.split(':');
    if (!fg || !bg || !min || !(fg in manual) || !(bg in manual) || !Number.isFinite(parseFloat(min))) throw new Error(`bad CONTRAST_EXTRA item: ${item}`);
    return { fg: fg as TokenName, bg: bg as TokenName, min: parseFloat(min) };
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const results = checkContrast([...defaultPairs(), ...extraPairs(process.env.CONTRAST_EXTRA)]);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.fg} on ${r.bg}: ${r.ratio.toFixed(2)} (min ${r.min})`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`CONTRAST ${results.length - failed} of ${results.length} pairs ok`);
  process.exit(failed === 0 ? 0 : 1);
}

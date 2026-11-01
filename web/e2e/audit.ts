// The shared clip audit for every UI ticket (AIR-183). It runs the kit's browser function `scripts/ui-clip-audit.js` at
// several widths and turns its report into one message per problem. The overflow verdict is scrollWidth against clientWidth in a
// non-mobile context: the kit field `overflowX` is scrollWidth minus innerWidth, and in a Playwright context created with
// `isMobile: true` Chromium grows `window.innerWidth` to the content width (measured on Chromium with Playwright 1.64.1: a
// 600 px element at a 375 px viewport gave innerWidth 600, clientWidth 375, scrollWidth 600, so the kit field read 0 and hid a
// 225 px overflow). So innerWidth is only checked, never used for the verdict.
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';

// repo root seen from web/e2e/: independent of the working directory (`pnpm -C web e2e` runs with cwd web/)
const repoRoot = new URL('../../', import.meta.url);

export const AUDIT_WIDTHS = [320, 375, 390] as const;
export const AUDIT_HEIGHT = 812;

export type Metrics = { innerWidth: number; clientWidth: number; scrollWidth: number };

/** Throws when the viewport was not honored (a mobile context), else one message for a horizontal overflow or none. */
export function overflowMessages(width: number, m: Metrics): string[] {
  if (m.innerWidth !== width) throw new Error(`viewport not honored: innerWidth ${m.innerWidth} for width ${width}`);
  return m.scrollWidth > m.clientWidth ? [`overflowX ${m.scrollWidth - m.clientWidth}`] : [];
}

let cachedSource: string | undefined;
const auditSource = (): string => (cachedSource ??= readFileSync(new URL('scripts/ui-clip-audit.js', repoRoot), 'utf8'));

const LISTS = ['clipped', 'corners', 'text', 'inputs'] as const;

/** Empty array when the page is clean at every width. Throws when the audit gives no result: an audit that returns nothing cannot pass a page. */
export async function clipAudit(page: Page, widths: readonly number[] = AUDIT_WIDTHS): Promise<string[]> {
  const messages: string[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: AUDIT_HEIGHT });
    const metrics = (await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))) as Metrics;
    // the file is an arrow function expression: Playwright does not call a function given as text, so call it here
    const report = (await page.evaluate(`(${auditSource()})()`)) as Record<string, unknown> | undefined | null;
    if (typeof report !== 'object' || report === null || typeof report.overflowX !== 'number') {
      throw new Error(`audit returned no result at ${width}px`);
    }
    for (const m of overflowMessages(width, metrics)) messages.push(`${width}px ${m}`);
    for (const list of LISTS) {
      const entries = report[list];
      if (!Array.isArray(entries)) throw new Error(`audit returned no result at ${width}px: ${list} is not a list`);
      for (const entry of entries) messages.push(`${width}px ${list}: ${String(entry)}`);
    }
  }
  return messages;
}

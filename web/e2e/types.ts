// What e2e/run.ts hands to every e2e/<name>.e2e.ts. Kept apart from run.ts, which starts a server when imported.
import type { Page } from 'playwright';

/**
 * `historyErrors`: on a `live-` run, the console errors of a request to the public history API (tx.test.fastnear.com; its 429 carries no CORS
 * header, so the browser logs a CORS error). They are handed to the suite instead of failing the run: the live smoke test decides (a site with
 * its state file keeps its numbers when the API throttles; a site without one fails).
 */
export type E2EContext = { page: Page; baseUrl: string; historyErrors?: string[] };
export type E2E = (ctx: E2EContext) => Promise<void>;

/** The default export of e2e/<name>.setup.ts: runs before the preview server starts; `env` is merged into process.env, `close` runs at the end. */
export type E2ESetup = () => Promise<{ env?: Record<string, string>; close(): Promise<void> }>;

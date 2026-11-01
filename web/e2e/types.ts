// What e2e/run.ts hands to every e2e/<name>.e2e.ts. Kept apart from run.ts, which starts a server when imported.
import type { Page } from 'playwright';

export type E2EContext = { page: Page; baseUrl: string };
export type E2E = (ctx: E2EContext) => Promise<void>;

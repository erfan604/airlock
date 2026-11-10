// AIR-351: the post-deploy smoke test, run against the hosted site itself (Cloudflare Pages), not a local build:
//   pnpm -C web smoke:live                                  (https://airlock-ere.pages.dev)
//   AIRLOCK_SMOKE_URL=https://<preview>.pages.dev pnpm -C web smoke:live
// It checks that every page answers 200 in its slash form, that the slashless form answers 308 to it (queries kept), that an unknown path is
// a 404, that no page logs a console error (the harness fails on any), and the owner rule on what a reader sees: no "erfan" and no "testnet"
// in the visible text of any page, case-insensitive, at 1440 and at 375. Link targets and attributes are not text. A paste-ready command
// (a visible <code> or <pre>) must stay exact, so the word "testnet" (the network argument of the near CLI) may appear there; the owner's name
// may not, except in the repository address github.com/erfan604/airlock. Text inside a closed fold is not visible until opened.
// On /challenge it also checks that the printed task has not expired, so a command a judge pastes is not refused before it runs.
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { PAGES } from '../src/pages.ts';
import type { E2E } from './types.ts';

const slashForm = (path: string): string => (path === '/' ? '/' : `${path}/`);

/** The 308s the host must keep: every page without its slash, and the two deep links the site prints. */
export function redirectsOf(paths: readonly string[]): { from: string; to: string }[] {
  const pages = paths.filter((p) => p !== '/').map((p) => ({ from: p, to: `${p}/` }));
  return [...pages, { from: '/try?s=hired', to: '/try/?s=hired' }, { from: '/credit?pool=fixture', to: '/credit/?pool=fixture' }];
}

const REPO = /github\.com\/erfan604\/airlock/gi;

/**
 * The owner-rule problems in what a reader sees: `prose` is the visible text with code hidden, `code` the visible code blocks. `payees` are the
 * payees printed on live approval cards: on that card the real payee wins over the owner-name rule (an approver must tell any two payees
 * apart), so the owner's name inside one of them is not a problem; the word testnet still is, and the card's trim removes it.
 */
export function visibleProblems(prose: string, code: readonly string[], payees: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const m of prose.matchAll(/.{0,40}testnet.{0,40}/gi)) out.push(`text: ${m[0].trim()}`);
  const named = payees.filter((p) => p.trim() !== '').reduce((t, p) => t.split(p.trim()).join(' '), prose);
  for (const m of named.matchAll(/.{0,40}erfan.{0,40}/gi)) out.push(`text: ${m[0].trim()}`);
  for (const c of code) for (const m of c.replace(REPO, '').matchAll(/.{0,40}erfan.{0,40}/gi)) out.push(`code: ${m[0].trim()}`);
  return out;
}

async function readVisible(page: Page): Promise<{ prose: string; code: string[]; payees: string[] }> {
  return page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('code, pre, kbd, samp'));
    // a block inside a closed <details> or otherwise not rendered has no boxes: it is not on screen
    const shown = blocks.filter((b) => b.getClientRects().length > 0 && !blocks.some((o) => o !== b && o.contains(b)));
    const code = shown.map((b) => b.innerText);
    const old = blocks.map((b) => b.style.display);
    blocks.forEach((b) => (b.style.display = 'none'));
    const prose = `${document.title}\n${document.body.innerText}`;
    blocks.forEach((b, i) => (b.style.display = old[i] ?? ''));
    // the payee of each approval card as it is printed (the TO row), for the one exemption of visibleProblems
    const payees = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="card"] [data-name="TO"] .manifest-value')).map((e) => e.innerText);
    return { prose, code, payees };
  });
}

const run: E2E = async ({ page, baseUrl }) => {
  // the detector itself, before it is trusted with the site
  assert.ok(visibleProblems('Runs on NEAR testnet.', []).length > 0);
  assert.ok(visibleProblems('Pay kanocotton.testnet', []).length > 0, 'an account id in text is not exempt');
  assert.ok(visibleProblems('Erfan', []).length > 0);
  assert.deepEqual(visibleProblems('Pay kanocotton', ['near account create-account <you>.testnet network-config testnet']), []);
  assert.deepEqual(visibleProblems('', ['git clone https://github.com/erfan604/airlock.git']), []);
  assert.ok(visibleProblems('', ['sign-as erfan-agent.testnet']).length > 0, "the owner's name in a visible command fails");
  assert.deepEqual(visibleProblems('Pay 1 NEAR to accountant.erfan-airlock?', [], ['accountant.erfan-airlock']), [], 'a live approval card names its real payee');
  assert.ok(visibleProblems('Pay 1 NEAR to accountant.erfan-airlock? Erfan says hi', [], ['accountant.erfan-airlock']).length > 0, 'only the payee itself is exempt');
  assert.ok(visibleProblems('Pay 1 NEAR to x.testnet?', [], ['x.testnet']).length > 0, 'testnet is never exempt');

  const found: string[] = [];
  const paths = PAGES.map((p) => p.path);

  // status codes, read without following redirects
  for (const path of paths) {
    const r = await page.request.get(`${baseUrl}${slashForm(path)}`, { maxRedirects: 0 });
    if (r.status() !== 200) found.push(`${slashForm(path)} answered ${String(r.status())}, not 200`);
  }
  for (const { from, to } of redirectsOf(paths)) {
    const r = await page.request.get(`${baseUrl}${from}`, { maxRedirects: 0 });
    const loc = r.headers()['location'];
    const at = loc === undefined ? null : new URL(loc, `${baseUrl}/`);
    if (r.status() !== 308 || at === null || `${at.pathname}${at.search}` !== to) found.push(`${from} answered ${String(r.status())} to ${loc ?? 'nowhere'}, not 308 to ${to}`);
  }
  const missing = await page.request.get(`${baseUrl}/no-such-page-${String(Date.now())}`, { maxRedirects: 0 });
  if (missing.status() !== 404) found.push(`an unknown path answered ${String(missing.status())}, not 404`);

  // what a reader sees, at a desktop and a phone width
  for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    for (const path of paths) {
      const res = await page.goto(`${baseUrl}${slashForm(path)}`, { waitUntil: 'load' });
      if (res?.status() !== 200) found.push(`${path} @${String(viewport.width)}: the browser got ${String(res?.status())}`);
      await page.locator('main').first().waitFor();
      // the chain reads (pool, challenge board, approvals) land after load; give them time so their text is part of the check
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
      const { prose, code, payees } = await readVisible(page);
      for (const p of visibleProblems(prose, code, payees)) found.push(`${path} @${String(viewport.width)} ${p}`);
    }
  }

  // the challenge: the task the printed command carries is still inside its validity
  await page.goto(`${baseUrl}/challenge/`);
  await page.locator('main').first().waitFor();
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  if ((await page.locator('[data-testid="task-expired"]').count()) > 0) found.push('/challenge: the page says the published task has expired');
  const taskJson = page.locator('[data-testid="task-json"]');
  if ((await taskJson.count()) > 0) {
    const task = JSON.parse(await taskJson.first().textContent() ?? '{}') as { task?: { expires_ms?: number } };
    const expires = task.task?.expires_ms;
    if (typeof expires !== 'number' || expires <= Date.now()) found.push(`/challenge: the printed task expires at ${String(expires)}, which is not in the future`);
  }

  assert.deepEqual(found, [], `live smoke against ${baseUrl}`);
};

export default run;

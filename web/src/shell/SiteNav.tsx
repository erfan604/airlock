// AIR-311: the console's tabs. Every route is a full page load (no client router), so the current tab is marked from the path the shell
// routed, with aria-current for assistive tech. The cross-document view transition of base.css animates the change between pages.
import { useEffect, useRef } from 'react';
import { url } from '../static.ts';

type NavItem = { path: string; label: string; match: string[] };

/** The header: the pages a stranger should touch, in this order (a blind read of the entry asked for fewer things). */
export const PRIMARY: NavItem[] = [
  { path: '', label: 'Overview', match: ['/'] },
  { path: 'lend', label: 'Lend', match: ['/lend'] },
  { path: 'rob', label: 'Rob it', match: ['/rob'] },
  { path: 'break', label: 'Break the proof', match: ['/break'] },
  { path: 'terms', label: 'Terms', match: ['/terms'] },
  { path: 'credit', label: 'Credit', match: ['/credit'] },
];

/** The second group: every other page, one click away from every page in the block above the footer (MoreNav). */
export const MORE: NavItem[] = [
  { path: 'try', label: 'Try it', match: ['/try'] },
  { path: 'use', label: 'Use it', match: ['/use'] },
  { path: 'replay', label: 'Replay', match: ['/replay', '/task'] },
  { path: 'approvals', label: 'Approvals', match: ['/approvals'] },
  { path: 'challenge', label: 'Challenge', match: ['/challenge'] },
  { path: 'bench', label: 'Bench', match: ['/bench'] },
  { path: 'proven', label: 'Proven', match: ['/proven'] },
];

/** Every page of the site, header first. */
export const NAV: NavItem[] = [...PRIMARY, ...MORE];

/** The fade under 1 px of scroll is noise: a strip scrolled to its end can stop a fraction of a pixel short. */
const SLACK = 1;

/** The edges of a scroll strip that have tabs past them, as the strip's `data-edge` value: '', 'start', 'end' or 'start end'. */
export function edgesOf(m: { scrollLeft: number; clientWidth: number; scrollWidth: number }): string {
  const start = m.scrollLeft > SLACK;
  const end = m.scrollLeft + m.clientWidth < m.scrollWidth - SLACK;
  return [start ? 'start' : '', end ? 'end' : ''].filter((x) => x !== '').join(' ');
}

/** Tabs a phone leaves to the More menu: the bar keeps Lend, Rob it and Break (one 44 px row), and More marks a current page it holds. */
const PHONE_MENU = new Set(['terms', 'credit']);
const PHONE_BAR = new Set(['', 'lend', 'rob', 'break']);
/** A phone's shorter label for a tab, where the full one does not fit the row. */
const SHORT: Record<string, string> = { break: 'Break' };

export function SiteNav({ path }: { path: string }) {
  // a strip wider than its box (a narrow laptop window) scrolls: bring the current tab fully into the strip (the strip's own scroll, never
  // the page's), and fade whichever edge has tabs beyond it, so a cut tab always reads as "more this way" (D20).
  const strip = useRef<HTMLUListElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const ul = strip.current;
    if (ul === null) return undefined;
    const mark = (): void => {
      ul.dataset.edge = edgesOf(ul);
    };
    const adjust = (): void => {
      const tab = ul.querySelector<HTMLElement>('[aria-current="page"]');
      if (tab !== null) {
        const left = tab.offsetLeft - ul.offsetLeft;
        const fade = 32;
        if (left + tab.offsetWidth > ul.scrollLeft + ul.clientWidth - fade || left < ul.scrollLeft + fade) ul.scrollLeft = Math.max(0, left - (ul.clientWidth - tab.offsetWidth) / 2);
      }
      mark();
    };
    adjust();
    // the tabs change width when the web fonts arrive: place the current tab again then
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) adjust();
    });
    ul.addEventListener('scroll', mark, { passive: true });
    // the strip changes width with the window and with the shell around it: mark again whenever its own box changes
    const seen = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(adjust);
    seen?.observe(ul);
    return () => {
      live = false;
      ul.removeEventListener('scroll', mark);
      seen?.disconnect();
    };
  }, [path]);
  useEffect(() => {
    // the More menu opens in place under the bar; a tap outside it or Escape closes it
    const close = (e: Event): void => {
      const d = menu.current;
      if (d === null || !d.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target instanceof Node && d.contains(e.target))) d.open = false;
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <>
      <nav className="site-nav" data-testid="site-nav" aria-label="Pages">
        <ul className="site-tabs" ref={strip} data-edge="">
          {[...PRIMARY, ...MORE.filter((n) => n.match.includes(path))].map((n) => {
            const current = n.match.includes(path);
            return (
              <li key={n.path} className={PHONE_BAR.has(n.path) ? undefined : 'site-wide'}>
                <a className="site-tab" href={url(n.path)} aria-current={current ? 'page' : undefined} data-testid={`tab-${n.path === '' ? 'overview' : n.path}`}>
                  {SHORT[n.path] === undefined ? (
                    n.label
                  ) : (
                    <>
                      <span className="site-tab-long">{n.label}</span>
                      <span className="site-tab-short">{SHORT[n.path]}</span>
                    </>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <details className="site-menu" ref={menu} data-testid="nav-more" data-current={NAV.some((n) => !PHONE_BAR.has(n.path) && n.match.includes(path)) ? 'true' : undefined}>
        <summary className="site-tab site-tab-more">More</summary>
        <ul className="site-menu-list" aria-label="More pages">
          {[...PRIMARY.filter((n) => PHONE_MENU.has(n.path)), ...MORE].map((n) => (
            <li key={n.path} className={PHONE_MENU.has(n.path) ? 'site-narrow' : undefined}>
              <a className="site-more-link" href={url(n.path)} aria-current={n.match.includes(path) ? 'page' : undefined} data-testid={`menu-${n.path}`}>
                {n.label}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/** The second group, above every page's footer: the pages a reader may want after the first six, as one quiet line of plain links. */
export function MoreNav({ path }: { path: string }) {
  return (
    <nav className="site-more" id="more" aria-label="More pages" data-testid="site-more">
      <h2 className="site-more-title">More of the entry</h2>
      <ul className="site-more-list">
        {MORE.map((n) => (
          <li key={n.path}>
            <a className="site-more-link" href={url(n.path)} aria-current={n.match.includes(path) ? 'page' : undefined} data-testid={`more-${n.path}`}>
              {n.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

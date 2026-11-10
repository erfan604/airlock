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

export function SiteNav({ path }: { path: string }) {
  // a phone shows the strip scrolled: bring the current tab fully into the strip (the strip's own scroll, never the page's), and fade
  // whichever edge has tabs beyond it, so a cut tab always reads as "more this way" (D20)
  const strip = useRef<HTMLUListElement>(null);
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
  return (
    <nav className="site-nav" data-testid="site-nav" aria-label="Pages">
      <ul className="site-tabs" ref={strip} data-edge="end">
        {[...PRIMARY, ...MORE.filter((n) => n.match.includes(path))].map((n) => {
          const current = n.match.includes(path);
          return (
            <li key={n.path}>
              <a className="site-tab" href={url(n.path)} aria-current={current ? 'page' : undefined} data-testid={`tab-${n.path === '' ? 'overview' : n.path}`}>
                {n.label}
              </a>
            </li>
          );
        })}
        <li>
          <a className="site-tab site-tab-more" href="#more" data-testid="nav-more">
            More
          </a>
        </li>
      </ul>
    </nav>
  );
}

/** The second group, above every page's footer: the pages a judge may want after the first six, as one quiet line of plain links. */
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

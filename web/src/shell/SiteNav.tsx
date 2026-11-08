// AIR-311: the console's tabs. Every route is a full page load (no client router), so the current tab is marked from the path the shell
// routed, with aria-current for assistive tech. The cross-document view transition of base.css animates the change between pages.
import { useEffect, useRef } from 'react';
import { url } from '../static.ts';

export const NAV: { path: string; label: string; match: string[] }[] = [
  { path: '', label: 'Overview', match: ['/'] },
  { path: 'try', label: 'Try it', match: ['/try'] },
  { path: 'use', label: 'Use it', match: ['/use'] },
  { path: 'replay', label: 'Replay', match: ['/replay', '/task'] },
  { path: 'credit', label: 'Credit', match: ['/credit'] },
  { path: 'approvals', label: 'Approvals', match: ['/approvals'] },
  { path: 'challenge', label: 'Challenge', match: ['/challenge'] },
  { path: 'bench', label: 'Bench', match: ['/bench'] },
  { path: 'proven', label: 'Proven', match: ['/proven'] },
];

export function SiteNav({ path }: { path: string }) {
  // a phone shows the strip scrolled: bring the current tab fully into the strip (the strip's own scroll, never the page's)
  const strip = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const ul = strip.current;
    const tab = ul?.querySelector<HTMLElement>('[aria-current="page"]');
    if (ul === null || ul === undefined || tab === null || tab === undefined) return;
    const left = tab.offsetLeft - ul.offsetLeft;
    if (left + tab.offsetWidth > ul.scrollLeft + ul.clientWidth - 28 || left < ul.scrollLeft) ul.scrollLeft = Math.max(0, left - (ul.clientWidth - tab.offsetWidth) / 2);
  }, [path]);
  return (
    <nav className="site-nav" data-testid="site-nav" aria-label="Pages">
      <ul className="site-tabs" ref={strip}>
        {NAV.map((n) => {
          const current = n.match.includes(path);
          return (
            <li key={n.path}>
              <a className="site-tab" href={url(n.path)} aria-current={current ? 'page' : undefined} data-testid={`tab-${n.path === '' ? 'overview' : n.path}`}>
                {n.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

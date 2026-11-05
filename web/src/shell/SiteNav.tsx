// AIR-311: the console's tabs. Every route is a full page load (no client router), so the current tab is marked from the path the shell
// routed, with aria-current for assistive tech. The cross-document view transition of base.css animates the change between pages.
import { url } from '../static.ts';

export const NAV: { path: string; label: string; match: string[] }[] = [
  { path: '', label: 'Overview', match: ['/'] },
  { path: 'try', label: 'Try it', match: ['/try'] },
  { path: 'use', label: 'Use it', match: ['/use'] },
  { path: 'replay', label: 'Replay', match: ['/replay', '/task', '/approvals'] },
  { path: 'bench', label: 'Bench', match: ['/bench'] },
  { path: 'proven', label: 'Proven', match: ['/proven'] },
];

export function SiteNav({ path }: { path: string }) {
  return (
    <nav className="site-nav" data-testid="site-nav" aria-label="Pages">
      <ul className="site-tabs">
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

// The shell: `/fixtures/<name>` renders a registered fixture, every other path its route from routes.ts (AIR-311: `/` is the landing). There is no client router yet: every route is a full page load, which is what the fixture screenshots want.
import { DoorSprite } from './components/Door.tsx';
import { getFixture } from './fixtures/index.ts';
import { ROUTES } from './routes.ts';
import { routePath, url } from './static.ts';
import { SiteNav } from './shell/SiteNav.tsx';

function Placeholder({ line }: { line: string }) {
  return (
    <main className="page" data-testid="placeholder">
      <h1 className="wordmark">AIRLOCK</h1>
      <p>{line}</p>
      <p>
        <a href={url('')}>Go to the overview</a>
      </p>
    </main>
  );
}

export function App({ pathname: rawPathname }: { pathname: string }) {
  const pathname = routePath(rawPathname);
  const m = /^\/fixtures\/([^/]+)\/?$/.exec(pathname);
  const fixture = m ? getFixture(m[1] as string) : undefined;
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
  return (
    <>
      <DoorSprite />
      <a className="skip-link" href="#main">
        Skip to the page
      </a>
      <header className="shell-bar" data-testid="shell-bar">
        <a className="shell-mark" href={url('')} aria-label="AIRLOCK, overview" aria-current={path === '/' ? 'page' : undefined}>
          AIRLOCK
        </a>
        <SiteNav path={path} />
        <span className="shell-net">testnet</span>
      </header>
      <div id="main" className="shell-main" tabIndex={-1}>
        {fixture ? fixture.render() : m ? <Placeholder line="No such fixture." /> : route ? route() : <Placeholder line="There is no page at this address." />}
      </div>
    </>
  );
}

// The shell: `/fixtures/<name>` renders a registered fixture, `/` a plain AIRLOCK placeholder (the Task page is AIR-184 and
// AIR-185). There is no client router yet: every route is a full page load, which is what the fixture screenshots want.
import { DoorSprite } from './components/Door.tsx';
import { getFixture } from './fixtures/index.ts';
import { ROUTES } from './routes.ts';
import { STATIC, routePath } from './static.ts';
import { StaticNav } from './static/StaticPages.tsx';

function Placeholder({ line }: { line: string }) {
  return (
    <main className="page" data-testid="placeholder">
      <h1 className="wordmark">AIRLOCK</h1>
      <p>{line}</p>
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
      <header className="shell-bar" data-testid="shell-bar">
        <span className="shell-mark">AIRLOCK</span>
        <span className="shell-net">testnet</span>
      </header>
      {STATIC ? <StaticNav /> : null}
      {fixture ? fixture.render() : m ? <Placeholder line="No such fixture." /> : route ? route() : <Placeholder line="Console shell. No task is open." />}
    </>
  );
}

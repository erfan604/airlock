// The shell: `/fixtures/<name>` renders a registered fixture, `/` a plain AIRLOCK placeholder (the Task page is AIR-184 and
// AIR-185). There is no client router yet: every route is a full page load, which is what the fixture screenshots want.
import { DoorSprite } from './components/Door.tsx';
import { getFixture } from './fixtures/index.ts';

function Placeholder({ line }: { line: string }) {
  return (
    <main className="page" data-testid="placeholder">
      <h1 className="wordmark">AIRLOCK</h1>
      <p>{line}</p>
    </main>
  );
}

export function App({ pathname }: { pathname: string }) {
  const m = /^\/fixtures\/([^/]+)\/?$/.exec(pathname);
  const fixture = m ? getFixture(m[1] as string) : undefined;
  return (
    <>
      <DoorSprite />
      {fixture ? fixture.render() : m ? <Placeholder line="No such fixture." /> : <Placeholder line="Console shell. No task is open." />}
    </>
  );
}

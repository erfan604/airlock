// AIR-310: the pages of the static build that need a live server say so plainly and point at the repo commands. Nothing here fetches, signs or
// opens a wallet; it is text and links.
import type { ReactElement } from 'react';
import { url } from '../static.ts';

type Need = { title: string; why: string; commands: { cmd: string; does: string }[] };

function NeedsServer({ need, testId }: { need: Need; testId: string }) {
  return (
    <main className="page static-page" data-testid={testId}>
      <p className="replay-banner" data-testid="replay-banner">
        Replay of recorded run: this hosted copy has no server
      </p>
      <h1 className="static-title">{need.title}</h1>
      <p className="replay-line" data-testid="needs-server">
        {need.why}
      </p>
      <ul className="static-commands">
        {need.commands.map((c) => (
          <li key={c.cmd} className="static-command">
            <code className="static-code">{c.cmd}</code>
            <span className="replay-line">{c.does}</span>
          </li>
        ))}
      </ul>
      <p className="replay-line">
        <a href={url('replay')}>Watch the recorded run</a>{' or '}<a href={url('try')}>try to trick the verdict in your browser</a>
      </p>
    </main>
  );
}

const LIVE: Need = {
  title: 'Live demo',
  why: 'A live run needs a runtime server, a model key and funded NEAR testnet accounts. None of that is in this hosted copy, which only replays recorded runs. Run it from the repository.',
  commands: [
    { cmd: 'pnpm i && pnpm demo', does: 'the same replay on your machine, with the real console server. Node and pnpm only, no keys.' },
    { cmd: 'pnpm demo:live --dry-run', does: 'the live demo path from recordings, no keys. Ends with DEMO LIVE DRY RUN OK.' },
    { cmd: 'pnpm demo:live', does: 'the live run. Needs funded testnet accounts and a model key.' },
  ],
};

export const StaticLive = (): ReactElement => <NeedsServer need={LIVE} testId="static-live" />;

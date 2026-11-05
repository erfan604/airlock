// A route that shows the replay console when the server behind the page is a replay server, and the live page otherwise (AIR-246). In replay
// mode the live preview and wallet code is never rendered, so it cannot run.
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { replayMode } from './api.ts';
import { ReplayShell } from './ReplayShell.tsx';
import { ReplaySummary } from './ReplaySummary.tsx';
import { preload } from '../preload.ts';

export function ReplayAware({ live }: { live: () => ReactElement }) {
  const [mode, setMode] = useState<'loading' | 'replay' | 'live'>('loading');
  useEffect(() => {
    let on = true;
    void replayMode().then((r) => on && setMode(r ? 'replay' : 'live'));
    return () => {
      on = false;
    };
  }, []);
  if (mode === 'loading') {
    // AIR-311: the static page carries the acts as text (prerendered), shown until the replay console is ready
    const acts = preload()?.replay;
    return acts === undefined ? <main className="page gate" data-testid="mode-loading" aria-busy="true" /> : <ReplaySummary acts={acts} />;
  }
  return mode === 'replay' ? <ReplayShell /> : live();
}

// A route that shows the replay console when the server behind the page is a replay server, and the live page otherwise (AIR-246). In replay
// mode the live preview and wallet code is never rendered, so it cannot run.
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { replayMode } from './api.ts';
import { ReplayShell } from './ReplayShell.tsx';

export function ReplayAware({ live }: { live: () => ReactElement }) {
  const [mode, setMode] = useState<'loading' | 'replay' | 'live'>('loading');
  useEffect(() => {
    let on = true;
    void replayMode().then((r) => on && setMode(r ? 'replay' : 'live'));
    return () => {
      on = false;
    };
  }, []);
  if (mode === 'loading') return <main className="page gate" data-testid="mode-loading" aria-busy="true" />;
  return mode === 'replay' ? <ReplayShell /> : live();
}

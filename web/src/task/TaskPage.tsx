// `/` (AIR-184): the Task page behind the login gate (AIR-182). Without a session the gate renders the login button and nothing else.
import type { ReactNode } from 'react';
import { SessionGate } from '../wallet/SessionGate.tsx';
import type { GateDeps } from '../wallet/SessionGate.tsx';
import { liveTaskDeps } from './liveDeps.ts';
import { TaskView } from './TaskView.tsx';
import type { TaskDeps } from './TaskView.tsx';

const LIVE: TaskDeps = liveTaskDeps();

/** The gate's children function: one TaskView with the session's account. */
export function TaskPageChildren(deps: TaskDeps = LIVE): (s: { accountId: string }) => ReactNode {
  return ({ accountId }) => <TaskView accountId={accountId} deps={deps} />;
}

export function TaskPage({ gate, deps }: { gate?: GateDeps; deps?: TaskDeps }) {
  return <SessionGate deps={gate}>{TaskPageChildren(deps)}</SessionGate>;
}

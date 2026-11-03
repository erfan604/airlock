// The console's routes by path. Each ticket adds its own entries: AIR-182 adds /approvals, AIR-184 adds /. The shell (App.tsx) reads this
// before it falls back to the placeholder. AIR-246: when the server behind the page is a replay server both routes show the replay console.
import { createElement, lazy, Suspense } from 'react';
import type { ReactElement } from 'react';
import { ApprovalsRoute } from './approvals/ApprovalsRoute.tsx';
import { ProvenPage } from './proven/ProvenPage.tsx';
import { ChallengeView } from './challenge/ChallengeView.tsx';
import { ReplayAware } from './replay/ReplayAware.tsx';
import { TaskPage } from './task/TaskPage.tsx';
// AIR-192: the read-only Bench page loads on demand, so the shell's bundle does not grow
const BenchPage = lazy(() => import('./bench/BenchPage.tsx'));

export const ROUTES: Record<string, () => ReactElement> = {
  '/': () => createElement(ReplayAware, { live: () => createElement(TaskPage) }),
  '/proven': () => createElement(ProvenPage),
  '/approvals': () => createElement(ReplayAware, { live: () => createElement(ApprovalsRoute) }),
  // AIR-301: the public Steal this agent page; it reads the challenge service and needs no session
  '/challenge': () => createElement(ChallengeView),
  '/bench': () => createElement(Suspense, { fallback: null }, createElement(BenchPage)),
};

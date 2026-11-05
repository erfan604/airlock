// The console's routes by path. Each ticket adds its own entries: AIR-182 adds /approvals, AIR-184 adds /. The shell (App.tsx) reads this
// before it falls back to the placeholder. AIR-246: when the server behind the page is a replay server both routes show the replay console.
import { createElement, lazy, Suspense } from 'react';
import type { ReactElement } from 'react';
import { ApprovalsRoute } from './approvals/ApprovalsRoute.tsx';
import { ProvenPage } from './proven/ProvenPage.tsx';
import { ChallengeView } from './challenge/ChallengeView.tsx';
import { ReplayAware } from './replay/ReplayAware.tsx';
import { TaskPage } from './task/TaskPage.tsx';
import { STATIC } from './static.ts';
import { StaticChallenge, StaticLive } from './static/StaticPages.tsx';
import { Landing } from './landing/Landing.tsx';
import { TryPage } from './try/TryPage.tsx';
// AIR-192: the read-only Bench page loads on demand, so the shell's bundle does not grow
const BenchPage = lazy(() => import('./bench/BenchPage.tsx'));

export const ROUTES: Record<string, () => ReactElement> = {
  // AIR-311: `/` is the landing in every mode. The replay console (or, behind a live runtime, the Task page) moved to `/replay`; `/task`
  // is the same route under the name a live operator reads.
  '/': () => createElement(Landing),
  '/try': () => createElement(TryPage),
  '/replay': () => createElement(ReplayAware, { live: () => createElement(TaskPage) }),
  '/task': () => createElement(ReplayAware, { live: () => createElement(TaskPage) }),
  '/proven': () => createElement(ProvenPage),
  '/approvals': () => createElement(ReplayAware, { live: () => createElement(ApprovalsRoute) }),
  // AIR-301: the public Steal this agent page; it reads the challenge service and needs no session
  // AIR-310: a hosted static copy has no challenge service, so the page says so and points at the commands
  '/challenge': () => createElement(STATIC ? StaticChallenge : ChallengeView),
  '/live': () => createElement(StaticLive),
  '/bench': () => createElement(Suspense, { fallback: null }, createElement(BenchPage)),
};

// The console's routes by path. Each ticket adds its own entries: AIR-182 adds /approvals, AIR-184 adds /. The shell (App.tsx) reads this
// before it falls back to the placeholder. AIR-246: when the server behind the page is a replay server both routes show the replay console.
import { createElement, lazy, Suspense } from 'react';
import type { ReactElement } from 'react';
import { ApprovalsRoute } from './approvals/ApprovalsRoute.tsx';
import { ProvenPage } from './proven/ProvenPage.tsx';
import { ChallengeView } from './challenge/ChallengeView.tsx';
import { hostedChallengeApi } from './challenge/hosted.ts';
import { ReplayAware } from './replay/ReplayAware.tsx';
import { TaskPage } from './task/TaskPage.tsx';
import { STATIC } from './static.ts';
import { StaticLive } from './static/StaticPages.tsx';
import { StaticApprovals } from './approvals/StaticApprovals.tsx';
import { Landing } from './landing/Landing.tsx';
import { TryPage } from './try/TryPage.tsx';
import { UsePage } from './use/UsePage.tsx';
// AIR-192: the read-only Bench page loads on demand, so the shell's bundle does not grow
const BenchPage = lazy(() => import('./bench/BenchPage.tsx'));

const hostedApi = hostedChallengeApi();

export const ROUTES: Record<string, () => ReactElement> = {
  // AIR-311: `/` is the landing in every mode. The replay console (or, behind a live runtime, the Task page) moved to `/replay`; `/task`
  // is the same route under the name a live operator reads.
  '/': () => createElement(Landing),
  '/try': () => createElement(TryPage),
  '/replay': () => createElement(ReplayAware, { live: () => createElement(TaskPage) }),
  '/task': () => createElement(ReplayAware, { live: () => createElement(TaskPage) }),
  '/proven': () => createElement(ProvenPage),
  // AIR-313: the quickstart for people, the same steps as docs/QUICKSTART.md
  '/use': () => createElement(UsePage),
  // AIR-318: the hosted static copy reads the pending requests from the chain and lets the owner act in a wallet; the replay stays at /replay
  '/approvals': () => (STATIC ? createElement(StaticApprovals) : createElement(ReplayAware, { live: () => createElement(ApprovalsRoute) })),
  // AIR-301: the public Steal this agent page; it reads the challenge service and needs no session
  // AIR-320: a hosted static copy has no challenge service: door two (the published key) works from the browser's own chain reads, door one says why it is shut
  '/challenge': () => createElement(ChallengeView, STATIC ? { api: hostedApi, pollMs: 30_000, hosted: true } : {}),
  '/live': () => createElement(StaticLive),
  '/bench': () => createElement(Suspense, { fallback: null }, createElement(BenchPage)),
};

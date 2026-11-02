// The console's routes by path. Each ticket adds its own entries: AIR-182 adds /approvals, AIR-184 adds /. The shell (App.tsx) reads this
// before it falls back to the placeholder. AIR-246: when the server behind the page is a replay server both routes show the replay console.
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { ApprovalsRoute } from './approvals/ApprovalsRoute.tsx';
import { ReplayAware } from './replay/ReplayAware.tsx';
import { TaskPage } from './task/TaskPage.tsx';

export const ROUTES: Record<string, () => ReactElement> = {
  '/': () => createElement(ReplayAware, { live: () => createElement(TaskPage) }),
  '/approvals': () => createElement(ReplayAware, { live: () => createElement(ApprovalsRoute) }),
};

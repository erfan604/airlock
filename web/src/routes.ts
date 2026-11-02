// The console's routes by path. Each ticket adds its own entries: AIR-182 adds /approvals, AIR-184 adds /. The shell (App.tsx) reads this
// before it falls back to the placeholder.
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { ApprovalsRoute } from './approvals/ApprovalsRoute.tsx';

export const ROUTES: Record<string, () => ReactElement> = {
  '/approvals': () => createElement(ApprovalsRoute),
};

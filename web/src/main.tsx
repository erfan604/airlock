// Entry point. The one global stylesheet set is imported here and nowhere else: components never import .css, so
// the test runner can load them.
// AIR-323: first, so zod is configured before any module builds a schema (the CSP has no unsafe-eval)
import { ZOD_JITLESS } from '@airlock/runtime/zod-nojit';
import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/components.css';
import './styles/card.css';
import './styles/preview.css';
import './styles/wallet.css';
import './styles/task.css';
import './styles/replay.css';
import './styles/proven.css';
import './styles/use.css';
import './styles/challenge.css';
import './styles/bench.css';
import './styles/fixtures.css';
import './styles/site.css';
import './styles/credit.css';
import './styles/break.css';
import './styles/lender.css';
import './styles/terms.css';
import { App } from './App.tsx';

if (!ZOD_JITLESS) throw new Error('zod is not configured without eval');
const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
const app = (
  <StrictMode>
    <App pathname={window.location.pathname} />
  </StrictMode>
);
// AIR-311: a page the static build prerendered with the same data the client reads (data-render="hydrate") is hydrated in place; a page whose
// content changes once its script runs (the replay summary turns into the console) is rendered fresh over the prerendered text.
if (root.dataset.render === 'hydrate') hydrateRoot(root, app);
else createRoot(root).render(app);

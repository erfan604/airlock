// Entry point. The one global stylesheet set is imported here and nowhere else: components never import .css, so
// the test runner can load them.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/components.css';
import './styles/card.css';
import './styles/fixtures.css';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <App pathname={window.location.pathname} />
  </StrictMode>,
);

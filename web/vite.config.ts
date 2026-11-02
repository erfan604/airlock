import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { defaultCspInputs, previewProxy } from './csp.ts';
import { CSP_NONCE_PLACEHOLDER, cspPreviewPlugin } from './vite-csp.ts';

const csp = defaultCspInputs();

export default defineConfig({
  plugins: [react(), cspPreviewPlugin(csp)],
  // Vite writes this value into every nonce attribute of the built index.html; the preview plugin swaps it per response
  html: { cspNonce: CSP_NONCE_PLACEHOLDER },
  build: {
    // nothing is inlined as a data: URI: font-src allows 'self' only
    assetsInlineLimit: 0,
    // The console imports a few pure functions from the runtime package (labels, money) through barrel files whose other modules build
    // zod schemas at load time. Without this the bundler must keep every one of them (+33 KB gzip for one function); with it an
    // import that nothing uses is dropped. Only the runtime's own sources are marked: no module of the console and no dependency.
    rolldownOptions: { treeshake: { moduleSideEffects: [{ test: /[\\/]runtime[\\/]src[\\/]/, sideEffects: false }] } },
  },
  // the console and the runtime share one origin, so the session cookie is sent (AIR-161's routes)
  preview: { proxy: previewProxy(csp.runtimeOrigin) },
});

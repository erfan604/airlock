import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { defaultCspInputs, previewProxy } from './csp.ts';
import { CSP_NONCE_PLACEHOLDER, cspPreviewPlugin } from './vite-csp.ts';

const csp = defaultCspInputs();

export default defineConfig({
  plugins: [react(), cspPreviewPlugin(csp)],
  // Vite writes this value into every nonce attribute of the built index.html; the preview plugin swaps it per response
  html: { cspNonce: CSP_NONCE_PLACEHOLDER },
  // nothing is inlined as a data: URI: font-src allows 'self' only
  build: { assetsInlineLimit: 0 },
  // the console and the runtime share one origin, so the session cookie is sent (AIR-161's routes)
  preview: { proxy: previewProxy(csp.runtimeOrigin) },
});

// Vite preview plugin (AIR-183): a per-response CSP nonce. `preview.headers` is static, so it cannot carry a nonce; this
// middleware draws 16 random bytes for every document response, sets the Content-Security-Policy header from buildCsp and
// serves index.html with the placeholder that `html.cspNonce` leaves (Vite docs, Content Security Policy) replaced by that nonce.
// It runs before the proxy and the static files, answers only document requests and passes everything else on.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { PROXY_PATHS, buildCsp } from './csp.ts';
import type { CspInputs } from './csp.ts';

/** The value for `html.cspNonce` in vite.config.ts: Vite writes it into every nonce attribute of the built index.html. */
export const CSP_NONCE_PLACEHOLDER = '__AIRLOCK_CSP_NONCE__';

export type CspPluginOptions = CspInputs & {
  /** Path prefixes that are proxied to the runtime and never answered with HTML. */
  proxiedPrefixes?: readonly string[];
};

const isProxied = (pathname: string, prefixes: readonly string[]): boolean => prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** The page itself: `/`, `/index.html` or a path whose last segment has no extension, that the client accepts as HTML. */
function isDocumentRequest(pathname: string, accept: string | undefined): boolean {
  if (accept !== undefined && !accept.includes('text/html') && !accept.includes('*/*')) return false;
  if (pathname === '/' || pathname === '/index.html') return true;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !last.includes('.');
}

export function cspPreviewPlugin(options: CspPluginOptions): Plugin {
  const { proxiedPrefixes = PROXY_PATHS, ...inputs } = options;
  return {
    name: 'airlock-csp-nonce',
    configurePreviewServer(server) {
      const indexPath = resolve(server.config.root, server.config.build.outDir, 'index.html');
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const pathname = (req.url ?? '/').split('?')[0] ?? '/';
        if (isProxied(pathname, proxiedPrefixes) || !isDocumentRequest(pathname, req.headers.accept)) return next();
        if (!existsSync(indexPath)) return next();
        const nonce = randomBytes(16).toString('base64');
        const html = readFileSync(indexPath, 'utf8').split(CSP_NONCE_PLACEHOLDER).join(nonce);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', buildCsp({ ...inputs, nonce }));
        res.end(req.method === 'HEAD' ? undefined : html);
      });
    },
  };
}

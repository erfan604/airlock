// Vite preview plugin (AIR-183): a per-response CSP nonce. `preview.headers` is static, so it cannot carry a nonce; this
// middleware draws 16 random bytes for every request and sets the Content-Security-Policy header from buildCsp, and serves
// index.html with the placeholder that `html.cspNonce` leaves (Vite docs, Content Security Policy) replaced by that nonce.
// It runs before the proxy and the static files.
//
// The header does not depend on how the path is spelled or what the client accepts: every GET and HEAD that Vite will not proxy
// gets the header BEFORE the request is passed on, so whatever the static server or the SPA fallback answers is covered. An HTML
// file served that way keeps the placeholder nonce, so its inline scripts are blocked: fail closed. Only a request that reduces
// to a document path (after decoding once, collapsing slashes and resolving dot segments) gets the index.html rewrite.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { PROXY_PATHS, buildCsp } from './csp.ts';
import type { CspInputs } from './csp.ts';

/** The value for `html.cspNonce` in vite.config.ts: Vite writes it into every nonce attribute of the built index.html. */
export const CSP_NONCE_PLACEHOLDER = '__AIRLOCK_CSP_NONCE__';

export type CspPluginOptions = CspInputs & {
  /** Path prefixes that Vite proxies to the runtime; those requests are never answered here. */
  proxiedPrefixes?: readonly string[];
};

/**
 * Vite proxies a request when its RAW url starts with a context string (createProxyContextMatcher in Vite 8.3.5), so this is the
 * same prefix test on the raw url and not on a normalized path. A spelling that Vite does not proxy (`/%2Fsession`, `/./session`)
 * is served as a console page and must get the policy, so it is not "proxied" here either.
 */
export function isProxiedUrl(rawUrl: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => rawUrl.startsWith(p));
}

export type RequestPath = { kind: 'path'; path: string } | { kind: 'malformed' } | { kind: 'other' };

/**
 * The path a raw request url stands for: query and fragment dropped, percent escapes decoded once, backslashes read as slashes,
 * duplicate slashes collapsed and dot segments resolved. A malformed escape or a NUL is `malformed` (answered 400); a url that is
 * not an absolute path (`*`, absolute form) is `other`.
 */
export function requestPath(rawUrl: string): RequestPath {
  const withoutQuery = /^[^?#]*/.exec(rawUrl)?.[0] ?? '';
  if (!withoutQuery.startsWith('/')) return { kind: 'other' };
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return { kind: 'malformed' };
  }
  if (decoded.includes('\0')) return { kind: 'malformed' };
  return { kind: 'path', path: posix.normalize(decoded.replaceAll('\\', '/')) };
}

/** The page itself: `/`, `/index.html` or a path whose last segment has no extension, that the client accepts as HTML. */
function isDocumentRequest(path: string, accept: string | undefined): boolean {
  if (accept !== undefined && !accept.includes('text/html') && !accept.includes('*/*')) return false;
  if (path === '/' || path === '/index.html') return true;
  const last = path.slice(path.lastIndexOf('/') + 1);
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
        const rawUrl = req.url ?? '/';
        if (isProxiedUrl(rawUrl, proxiedPrefixes)) return next();

        // before anything else can answer: the static server, the SPA fallback and the 404 handler all send this header
        const nonce = randomBytes(16).toString('base64');
        res.setHeader('Content-Security-Policy', buildCsp({ ...inputs, nonce }));

        const target = requestPath(rawUrl);
        if (target.kind === 'malformed') {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          return res.end(req.method === 'HEAD' ? undefined : 'Bad Request');
        }
        if (target.kind !== 'path' || !isDocumentRequest(target.path, req.headers.accept) || !existsSync(indexPath)) return next();

        const html = readFileSync(indexPath, 'utf8').split(CSP_NONCE_PLACEHOLDER).join(nonce);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(req.method === 'HEAD' ? undefined : html);
      });
    },
  };
}

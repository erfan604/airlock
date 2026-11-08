// AIR-310: the Vite plugin of the static build (`vite build --mode static`). It puts the policy of csp.ts into the page as a meta tag, and after
// the files are written it makes the output usable from plain files on any static host: a copy of index.html at every route (`/proven/index.html`,
// so no host rewrite is needed), `404.html` (GitHub Pages and Cloudflare Pages both serve it for an unknown path), `_headers` with the policy and
// the usual security headers for hosts that read it (Cloudflare Pages, Netlify), and `.nojekyll` so GitHub Pages serves every file as it is.
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { buildStaticCsp } from './csp.ts';

/** The console routes that get their own `index.html`. */
export const STATIC_ROUTES = ['try', 'replay', 'task', 'proven', 'bench', 'challenge', 'live', 'approvals', 'credit'] as const;

/** The `_headers` file (Cloudflare Pages and Netlify syntax). Paths are from the site root, whatever the base path of the build is. */
export function headersFile(nonce: string): string {
  return [
    '/*',
    `  Content-Security-Policy: ${buildStaticCsp({ header: true, nonce })}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
    // hashed bundles never change; the recorded data changes only with a new build
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
}

export function staticPlugin(): Plugin {
  let outDir = '';
  // one nonce per build, in the page's meta tags and in `_headers` (AIR-318)
  const nonce = randomBytes(16).toString('base64');
  return {
    name: 'airlock-static',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: buildStaticCsp({ header: false, nonce }) }, injectTo: 'head-prepend' },
        // the page reads this for the wallet connector's cspNonce (wallet/nonce.ts)
        { tag: 'meta', attrs: { property: 'csp-nonce', nonce }, injectTo: 'head-prepend' },
      ],
    },
    writeBundle() {
      const index = join(outDir, 'index.html');
      for (const route of STATIC_ROUTES) {
        mkdirSync(join(outDir, route), { recursive: true });
        copyFileSync(index, join(outDir, route, 'index.html'));
      }
      copyFileSync(index, join(outDir, '404.html'));
      writeFileSync(join(outDir, '_headers'), headersFile(nonce));
      writeFileSync(join(outDir, '.nojekyll'), '');
    },
  };
}

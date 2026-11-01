// CSP builder, the per-response nonce plugin and the preview proxy (AIR-183).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { preview } from 'vite';
import type { PreviewServer } from 'vite';
import { ICON_ORIGINS, NEAR_RPC, WALLET_ORIGINS, buildCsp, defaultCspInputs, normalizeNonce, previewProxy } from '../csp.ts';
import { CSP_NONCE_PLACEHOLDER, cspPreviewPlugin } from '../vite-csp.ts';

const RPC = ['https://a.example', 'https://b.example', 'https://c.example'];

const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d): [string, string[]] => {
        const [name, ...values] = d.split(/\s+/);
        return [name as string, values];
      }),
  );

test('csp: buildCsp has every directive of the ticket in order', () => {
  const nonce = 'abc123NONCE==';
  const csp = buildCsp({ runtimeOrigin: 'http://localhost:8787', nearRpc: RPC, walletOrigins: WALLET_ORIGINS, iconOrigins: ICON_ORIGINS, nonce });
  assert.equal(
    csp,
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: ${ICON_ORIGINS.join(' ')}`,
      "font-src 'self'",
      `connect-src 'self' http://localhost:8787 ${RPC.join(' ')} ${WALLET_ORIGINS.join(' ')}`,
      `frame-src 'self' ${WALLET_ORIGINS.join(' ')}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  assert.ok(csp.includes(`script-src 'self' 'nonce-${nonce}'`));
  assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"));
  assert.ok(csp.includes(`img-src 'self' data: ${ICON_ORIGINS[0]}`));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes(`connect-src 'self' http://localhost:8787 ${RPC.join(' ')}`));
  assert.equal(csp.includes('unsafe-eval'), false);
});

test('csp: script-src never allows unsafe-inline or unsafe-eval, and only style-src allows inline', () => {
  const csp = buildCsp({ runtimeOrigin: 'http://localhost:8787', nearRpc: RPC, walletOrigins: WALLET_ORIGINS, iconOrigins: ICON_ORIGINS, nonce: 'n' });
  const d = directives(csp);
  const script = d.get('script-src');
  assert.ok(script);
  assert.equal(script.includes("'unsafe-inline'"), false);
  assert.equal(script.includes("'unsafe-eval'"), false);
  assert.equal(script.includes('data:'), false);
  for (const [name, values] of d) if (name !== 'style-src') assert.equal(values.includes("'unsafe-inline'"), false, name);
  assert.ok(d.get('style-src')?.includes("'unsafe-inline'"));
});

test('csp: the starting origin lists are the ones of the ticket and the NEAR list follows STACK order', () => {
  assert.deepEqual(WALLET_ORIGINS, ['https://raw.githubusercontent.com', 'https://cdn.jsdelivr.net', 'https://wallet.intear.tech']);
  assert.deepEqual(ICON_ORIGINS, ['https://raw.githubusercontent.com']);
  assert.deepEqual(NEAR_RPC, [
    'https://test.rpc.fastnear.com',
    'https://near-testnet.drpc.org',
    'https://testnet-rpc.intea.rs',
    'https://rpc.testnet.near.org',
  ]);
  assert.equal(normalizeNonce("script-src 'self' 'nonce-abc+/=='; x"), "script-src 'self' 'nonce-NONCE'; x");
  assert.equal(defaultCspInputs().runtimeOrigin, process.env.VITE_RUNTIME_ORIGIN ?? 'http://localhost:8787');
});

// ---- the plugin and the proxy, on a real Vite preview server over a scratch dist and a stub runtime ----

let stub: http.Server;
let stubOrigin = '';
let server: PreviewServer;
let base = '';
let seenByStub: http.IncomingHttpHeaders = {};

before(async () => {
  stub = http.createServer((req, res) => {
    if (req.url === '/session') {
      seenByStub = req.headers;
      res.setHeader('Set-Cookie', ['sid=abc123; Path=/; HttpOnly; SameSite=Strict']);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/runs/x/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        res.write(`data: ${JSON.stringify({ n })}\n\n`);
        if (n === 4) {
          clearInterval(timer);
          res.end();
        }
      }, 60);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.statusCode = 404;
    res.end('stub 404');
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubOrigin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

  const dist = mkdtempSync(join(tmpdir(), 'airlock-csp-'));
  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html><html><head><meta property="csp-nonce" nonce="${CSP_NONCE_PLACEHOLDER}"></head><body><div id="root"></div>` +
      `<script type="module" crossorigin nonce="${CSP_NONCE_PLACEHOLDER}" src="/assets/x.js"></script></body></html>`,
  );
  server = await preview({
    configFile: false,
    root: dist,
    logLevel: 'silent',
    build: { outDir: '.' },
    plugins: [cspPreviewPlugin({ ...defaultCspInputs(), runtimeOrigin: stubOrigin })],
    preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: previewProxy(stubOrigin) },
  });
  base = (server.resolvedUrls?.local[0] ?? '').replace(/\/$/, '');
  assert.ok(base.startsWith('http://'), 'preview server url');
});

after(async () => {
  await server?.close();
  await new Promise<void>((resolve) => stub?.close(() => resolve()));
});

const nonceOf = (header: string | null): string => /'nonce-([^']+)'/.exec(header ?? '')?.[1] ?? '';

test('plugin: two consecutive requests get different nonces of at least 16 random bytes', async () => {
  const a = await fetch(`${base}/fixtures/components`);
  const b = await fetch(`${base}/fixtures/components`);
  const na = nonceOf(a.headers.get('content-security-policy'));
  const nb = nonceOf(b.headers.get('content-security-policy'));
  assert.ok(na && nb);
  assert.notEqual(na, nb);
  assert.ok(Buffer.from(na, 'base64').length >= 16, na);
  assert.ok(Buffer.from(nb, 'base64').length >= 16, nb);
});

test('plugin: the header nonce equals the nonce attribute in the served HTML and no placeholder is left', async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  const header = res.headers.get('content-security-policy');
  const n = nonceOf(header);
  assert.ok(n);
  assert.equal(html.includes(CSP_NONCE_PLACEHOLDER), false);
  const attrs = [...html.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(attrs.length >= 2);
  for (const a of attrs) assert.equal(a, n);
  assert.equal(
    normalizeNonce(header ?? ''),
    normalizeNonce(buildCsp({ ...defaultCspInputs(), runtimeOrigin: stubOrigin, nonce: 'x' })),
  );
});

test('proxy: /session reaches the stub with Cookie and Host preserved and Set-Cookie comes back unchanged', async () => {
  const host = new URL(base).host;
  const res = await fetch(`${base}/session`, { headers: { Cookie: 'sid=prev; other=1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(seenByStub.cookie, 'sid=prev; other=1');
  assert.equal(seenByStub.host, host, 'Host is the console host, so the session cookie belongs to one origin');
  assert.deepEqual(res.headers.getSetCookie(), ['sid=abc123; Path=/; HttpOnly; SameSite=Strict']);
});

test('proxy: a streaming SSE body from /runs/x/events arrives in more than one chunk', async () => {
  const res = await fetch(`${base}/runs/x/events`);
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') ?? '').startsWith('text/event-stream'));
  assert.ok(res.body);
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for await (const part of res.body) chunks.push(decoder.decode(part, { stream: true }));
  assert.ok(chunks.length > 1, `got ${chunks.length} chunk(s)`);
  const all = chunks.join('');
  for (let n = 1; n <= 4; n++) assert.ok(all.includes(`data: {"n":${n}}`), String(n));
});

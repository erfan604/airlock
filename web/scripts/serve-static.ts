// AIR-310: a small static file server that behaves like the hosts of docs/HOSTED_DEMO.md: it serves web/dist-static as files, a directory gets its
// index.html, an unknown path gets 404.html with status 404, and the headers of the `/*` block of `_headers` go on every response (so the
// Content-Security-Policy that Cloudflare Pages would send is the one the browser enforces here). Used by `pnpm -C web e2e static` and by
// `pnpm -C web preview:static [port]` for a look by hand. It serves from the directory only: a path that leaves it is a 404.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  // AIR-311: the Try page's verdict module and the landing media
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

/** The header lines under the first block of a `_headers` file (the `/*` block). */
export function starHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inFirst = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith(' ') && line.trim() !== '') {
      if (inFirst) break;
      inFirst = true;
      continue;
    }
    const at = line.indexOf(':');
    if (inFirst && at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

export function serveStatic(dir: string, port: number): Promise<{ url: string; server: Server; close(): Promise<void> }> {
  const root = resolve(dir);
  if (!existsSync(join(root, 'index.html'))) throw new Error(`${root}/index.html is missing: run \`pnpm build:static\` first`);
  const headers = existsSync(join(root, '_headers')) ? starHeaders(readFileSync(join(root, '_headers'), 'utf8')) : {};
  const server = createServer((req, res) => {
    const raw = (req.url ?? '/').split('?')[0] ?? '/';
    let path: string;
    try {
      path = normalize(decodeURIComponent(raw));
    } catch {
      path = '/';
    }
    let file = resolve(root, `.${path}`);
    if (file !== root && !file.startsWith(root + sep)) file = join(root, '404.html');
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    const found = existsSync(file) && statSync(file).isFile();
    if (!found) file = join(root, '404.html');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    const body = readFileSync(file);
    // a single byte range, as every static host answers one: a browser asks for media in ranges
    const range = found ? /^bytes=([0-9]{0,15})-([0-9]{0,15})$/.exec(req.headers.range ?? '') : null;
    res.setHeader('Accept-Ranges', 'bytes');
    if (range !== null && (range[1] !== '' || range[2] !== '')) {
      const size = body.length;
      const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(size - 1, Number(range[2]));
      if (start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${String(size)}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${String(start)}-${String(end)}/${String(size)}`);
      res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
      return;
    }
    res.statusCode = found ? 200 : 404;
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr !== null ? addr.port : port;
      ok({ url: `http://127.0.0.1:${String(p)}`, server, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const port = Number(process.argv[2] ?? '4180');
  const s = await serveStatic(join(import.meta.dirname, '..', 'dist-static'), port);
  console.log(`static console ${s.url}`);
}

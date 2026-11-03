// Pre-lock video capture helper: serves web/dist and proxies /api/challenge to the local challenge service.
// Usage: node scripts/video-serve.mjs [port] [upstream]   (env BENCH_JSON overrides /bench.json; defaults 4180 and http://127.0.0.1:8788)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
const port = Number(process.argv[2] ?? 4180);
const up = new URL(process.argv[3] ?? 'http://127.0.0.1:8788');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };
http.createServer((req, res) => {
  if (process.env.BENCH_JSON && req.url.split('?')[0] === '/bench.json') { res.writeHead(200, { 'content-type': 'application/json' }); fs.createReadStream(process.env.BENCH_JSON).pipe(res); return; }
  if (req.url.startsWith('/api/')) {
    const p = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(p);
    return;
  }
  let f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(port, '127.0.0.1');

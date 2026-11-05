// AIR-167: the mechanical review of the console's Content-Security-Policy over the built web/dist.
//   node scripts/csp-check.mjs                  serve web/dist with the real preview plugin on port 0, request the pages, check the headers
//   node scripts/csp-check.mjs --policy '<csp>' lint one policy string only (scripts/security-pass.sh --selftest plants a bad one)
// Prints `FAIL <reason>` per problem and exits 1, or prints `CSP OK`. Run from web/ (pnpm -C web exec node scripts/csp-check.mjs).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_ORIGIN = process.env.VITE_RUNTIME_ORIGIN ?? 'http://localhost:8787';

function directives(policy) {
  const map = new Map();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) map.set(tokens[0], tokens.slice(1));
  }
  return map;
}

/** Every problem of one policy; `nonce` is the nonce the page carries (or null when only a string is linted). */
export function lintPolicy(policy, nonce = null) {
  const problems = [];
  const d = directives(policy);
  const script = d.get('script-src') ?? [];
  if (script.length === 0) problems.push('script-src is missing');
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'strict-dynamic'", '*', 'https:', 'http:', 'data:', 'blob:']) {
    if (script.includes(bad)) problems.push(`script-src contains ${bad}`);
  }
  const nonces = script.filter((t) => /^'nonce-[A-Za-z0-9+/=]+'$/.test(t));
  if (!script.includes("'self'")) problems.push("script-src lacks 'self'");
  if (nonces.length !== 1) problems.push(`script-src carries ${nonces.length} nonces, expected exactly one`);
  // AIR-311: 'wasm-unsafe-eval' compiles the same-origin verdict.wasm of the Try page; it allows no JavaScript eval
  const other = script.filter((t) => t !== "'self'" && t !== "'wasm-unsafe-eval'" && !nonces.includes(t));
  if (other.length > 0) problems.push(`script-src has extra sources: ${other.join(' ')}`);
  if (nonce !== null && !script.includes(`'nonce-${nonce}'`)) problems.push('script-src nonce is not the page nonce');

  const style = d.get('style-src') ?? [];
  const wideStyle = style.filter((t) => t !== "'self'" && t !== "'unsafe-inline'" && !/^https:\/\/[a-z0-9.-]+$/.test(t));
  if (!style.includes("'self'") || !style.includes("'unsafe-inline'")) problems.push("style-src must be 'self' 'unsafe-inline' (docs/PLUMBING.md)");
  if (wideStyle.length > 0) problems.push(`style-src is wider than documented: ${wideStyle.join(' ')}`);

  for (const name of ['img-src', 'font-src', 'connect-src', 'frame-src', 'default-src', 'style-src']) {
    for (const token of d.get(name) ?? []) {
      if (token === '*' || /^\*\./.test(token)) problems.push(`${name} has the wildcard ${token}`);
      if (name === 'img-src' && token === 'https:') problems.push('img-src has https:');
      if ((name === 'connect-src' || name === 'frame-src') && /^[a-z][a-z0-9+.-]*:$/.test(token)) problems.push(`${name} has the bare scheme ${token}`);
      if ((name === 'connect-src' || name === 'frame-src') && token.startsWith('http://') && token !== RUNTIME_ORIGIN) {
        problems.push(`${name} has the http origin ${token}`);
      }
    }
  }
  const expectOne = (name, value) => {
    const have = d.get(name);
    if (have === undefined || have.length !== 1 || have[0] !== value) problems.push(`${name} must be exactly ${value}`);
  };
  expectOne('frame-ancestors', "'none'");
  expectOne('object-src', "'none'");
  expectOne('base-uri', "'none'");
  return problems;
}

function nonceOfMeta(html) {
  const tag = /<meta\b[^>]*property="csp-nonce"[^>]*>/.exec(html)?.[0];
  return tag === undefined ? null : (/\snonce="([^"]*)"/.exec(tag)?.[1] ?? null);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function main() {
  const failures = [];
  const flag = process.argv.indexOf('--policy');
  if (flag >= 0) {
    for (const p of lintPolicy(process.argv[flag + 1] ?? '')) failures.push(p);
    return failures;
  }
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const dist = join(root, 'dist');
  if (!existsSync(join(dist, 'index.html'))) return ['web/dist/index.html is missing: build first'];

  const { preview } = await import('vite');
  const server = await preview({ root, preview: { port: 0, host: '127.0.0.1', strictPort: false, open: false } });
  try {
    const address = server.httpServer.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
    const seen = [];
    for (const path of ['/', '/', '/fixtures/components']) {
      const res = await fetch(base + path, { headers: { accept: 'text/html' } });
      const policy = res.headers.get('content-security-policy');
      const html = await res.text();
      if (policy === null) {
        failures.push(`${path} has no content-security-policy header`);
        continue;
      }
      const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1] ?? null;
      const meta = nonceOfMeta(html);
      if (meta === null) failures.push(`${path} has no csp-nonce meta tag`);
      else if (meta !== nonce) failures.push(`${path} csp-nonce meta tag differs from the header nonce`);
      for (const p of lintPolicy(policy, nonce)) failures.push(`${path}: ${p}`);
      if (nonce !== null) seen.push(nonce);
      for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
        if (!/\ssrc=/.test(tag)) failures.push(`${path} has an inline script: ${tag}`);
        if (!tag.includes(`nonce="${nonce}"`)) failures.push(`${path} has a script without the response nonce: ${tag}`);
      }
    }
    if (seen.length >= 2 && new Set(seen).size !== seen.length) failures.push('two responses carried the same nonce');
  } finally {
    await server.close();
  }

  // the built index.html: every script has a src; no nonce value is baked into the bundle
  const built = readFileSync(join(dist, 'index.html'), 'utf8');
  for (const tag of built.match(/<script\b[^>]*>/g) ?? []) if (!/\ssrc=/.test(tag)) failures.push(`dist/index.html has an inline script: ${tag}`);
  for (const file of walk(dist)) {
    if (/nonce-[A-Za-z0-9+/=]{16,}/.test(readFileSync(file, 'latin1'))) failures.push(`${file} contains a nonce value`);
  }
  return failures;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = await main();
  for (const f of failures) console.log(`FAIL ${f}`);
  if (failures.length > 0) process.exit(1);
  console.log('CSP OK');
  process.exit(0);
}

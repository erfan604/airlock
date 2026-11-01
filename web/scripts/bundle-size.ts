// Sums the gzip size of the scripts web/dist/index.html loads (script tags and modulepreload links) and exits 1 above the budget.
// Usage: tsx scripts/bundle-size.ts <budget in KB>   (1 KB = 1000 bytes). The budget is for the shell only: routes that lazy-load
// the analyzer assert their own, larger budget in their own check.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const budget = parseFloat(process.argv[2] ?? '');
if (!Number.isFinite(budget) || budget <= 0) {
  console.error('usage: tsx scripts/bundle-size.ts <budget in KB>');
  process.exit(2);
}

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath)) {
  console.error('web/dist/index.html is missing: run `pnpm -C web build` first');
  process.exit(2);
}

const html = readFileSync(indexPath, 'utf8');
const refs = new Set<string>();
for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) refs.add(m[1] as string);
for (const m of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g)) refs.add(m[1] as string);
for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="modulepreload"/g)) refs.add(m[1] as string);
if (refs.size === 0) {
  console.error('index.html loads no script: the build is wrong');
  process.exit(2);
}

let bytes = 0;
for (const ref of refs) {
  const file = join(dist, ref.replace(/^\//, ''));
  if (!existsSync(file)) {
    console.error(`index.html references a missing file: ${ref}`);
    process.exit(2);
  }
  const gz = gzipSync(readFileSync(file), { level: 9 }).length;
  console.log(`${ref}: ${gz} bytes gzip`);
  bytes += gz;
}
const kb = bytes / 1000;
console.log(`BUNDLE ${kb.toFixed(1)} KB gzip (budget ${budget})`);
process.exit(kb > budget ? 1 : 0);

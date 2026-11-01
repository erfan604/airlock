// Copies the five latin woff2 files the console uses out of @fontsource into public/fonts/ (the files are committed, so a build
// never needs this script; run it after bumping the @fontsource pins). B612 and IBM Plex Mono 400 and 700, Courier Prime 400.
// The stencil family is cut (DESIGN fallback: Plex Mono 700 capitals for labels).
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outDir = fileURLToPath(new URL('../public/fonts/', import.meta.url));

const FILES: ReadonlyArray<{ name: string; weights: readonly number[] }> = [
  { name: 'b612', weights: [400, 700] },
  { name: 'ibm-plex-mono', weights: [400, 700] },
  { name: 'courier-prime', weights: [400] },
];

mkdirSync(outDir, { recursive: true });
let total = 0;
let count = 0;
for (const { name, weights } of FILES) {
  const pkgDir = dirname(require.resolve(`@fontsource/${name}/package.json`));
  for (const weight of weights) {
    const file = `${name}-latin-${weight}-normal.woff2`;
    copyFileSync(join(pkgDir, 'files', file), join(outDir, file));
    total += statSync(join(outDir, file)).size;
    count += 1;
  }
}
console.log(`FONTS ${count} files, ${total} bytes`);

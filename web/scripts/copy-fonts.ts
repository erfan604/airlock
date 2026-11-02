// Copies the latin woff2 files the console uses out of @fontsource into public/fonts/ (the files are committed, so a build never
// needs this script; run it after bumping the @fontsource pins). D24 (AIR-296): Mona Sans 400 to 700 is the system voice (the free face
// near.org itself ships next to its display grotesk), IBM Plex Mono 400, 500 and 700 the data, Courier Prime 400 only for outsider text.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outDir = fileURLToPath(new URL('../public/fonts/', import.meta.url));

const FILES: ReadonlyArray<{ name: string; weights: readonly number[] }> = [
  { name: 'mona-sans', weights: [400, 500, 600, 700] },
  { name: 'ibm-plex-mono', weights: [400, 500, 700] },
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

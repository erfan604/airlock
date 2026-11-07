// AIR-319: bundles src/cli.ts into dist/cli.js (one file, Node 22+, no dependencies, no install scripts). The verdict WebAssembly is inlined as
// base64 in place of src/wasm.ts, and the repo LICENSE is copied next to the package so `npm pack` ships it.
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(here, '..', '..', 'web', 'public', 'verdict.wasm'));
const inlineWasm = {
  name: 'inline-verdict-wasm',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]wasm\.ts$/ }, () => ({
      loader: 'ts',
      contents: `export const verdictWasmBytes = (): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from('${wasm.toString('base64')}', 'base64'));`,
    }));
  },
};

await build({
  entryPoints: [join(here, 'src', 'cli.ts')],
  outfile: join(here, 'dist', 'cli.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module";const require = __cr(import.meta.url);' },
  plugins: [inlineWasm],
  logLevel: 'warning',
});
copyFileSync(join(here, '..', '..', 'LICENSE'), join(here, 'LICENSE'));
console.error(`built dist/cli.js ${String(statSync(join(here, 'dist', 'cli.js')).size)} bytes`);

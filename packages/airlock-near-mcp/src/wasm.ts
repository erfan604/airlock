// AIR-319: the bytes of the verdict WebAssembly. From source (tests, tsx) they are read from web/public/verdict.wasm, the committed build of
// contracts/airlock-verdict-wasm (scripts/build-verdict-wasm.sh). build.mjs swaps this module for one that holds the same bytes inline, so the
// published package needs no file next to it and no Rust.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function verdictWasmBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(fileURLToPath(new URL('../../../web/public/verdict.wasm', import.meta.url))));
}

// Writes src/styles/tokens.css from tokens.ts. With the check flag it writes nothing and exits 1 when the committed file differs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tokensCss } from '../src/styles/tokens.ts';

const target = fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url));
const wanted = tokensCss();

if (process.argv.includes('--check')) {
  const have = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (have !== wanted) {
    console.error('tokens.css is out of date: run `pnpm -C web exec tsx scripts/emit-tokens.ts`');
    process.exit(1);
  }
  console.log('TOKENS OK');
} else {
  writeFileSync(target, wanted);
  console.log(`wrote ${target}`);
}

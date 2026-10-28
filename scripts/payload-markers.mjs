#!/usr/bin/env node
// AIR-125: writes fixtures/payload-markers.txt, the marker list of the repo's one payload leak scan (scripts/payload-scan.sh;
// AIR-276's claims lint reads the same file). A marker is every line of 30 or more characters, after trimming, of every
// fixtures/payloads/*.txt and bench/fixtures/payloads/*.txt (the bench folder may be absent), and every requirements.description
// of 30 or more characters in fixtures/x402/*.json; lowercased, cut to 60 code points, sorted by code units, unique, one per line.
// Usage: node scripts/payload-markers.mjs [--check]   (--check regenerates in memory and exits 1 when the file on disk differs)
// Node 24, standard library only; finds the repo root from its own path.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'fixtures', 'payload-markers.txt');
const filesIn = (dir, ext) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(ext)).sort().map((n) => join(dir, n)) : []);

const texts = [];
for (const f of [...filesIn(join(root, 'fixtures', 'payloads'), '.txt'), ...filesIn(join(root, 'bench', 'fixtures', 'payloads'), '.txt')]) {
  texts.push(...readFileSync(f, 'utf8').split('\n'));
}
for (const f of filesIn(join(root, 'fixtures', 'x402'), '.json')) {
  const description = JSON.parse(readFileSync(f, 'utf8'))?.requirements?.description;
  if (typeof description === 'string') texts.push(description);
}
const markers = new Set();
for (const t of texts) {
  const trimmed = t.trim();
  if ([...trimmed].length >= 30) markers.add([...trimmed.toLowerCase()].slice(0, 60).join(''));
}
const sorted = [...markers].sort();
const body = sorted.map((m) => m + '\n').join('');

if (process.argv.includes('--check')) {
  const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
  if (current !== body) {
    console.log('STALE fixtures/payload-markers.txt: run node scripts/payload-markers.mjs and commit it');
    process.exit(1);
  }
  console.log(`payload markers current (${sorted.length})`);
} else {
  writeFileSync(outPath, body);
  console.log(`wrote fixtures/payload-markers.txt (${sorted.length} markers)`);
}

// AIR-189: measured detection and false-positive counts (F10 section 5). Seeded 32-bit LCG (20261022), so the counts repeat.
// These flag every generated first-4 and last-4 variant; they do not show that address poisoning is detected in general.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLookalike } from '../src/dsl/index.ts';

const HEX = '0123456789abcdef';
let state = 20261022;
function next(): number {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state;
}
function digits(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += HEX.charAt((next() >>> 16) % 16);
  return out;
}

// a variant that keeps the first 4 and last 4 digits of the body and randomizes the middle
function variant(body: string): string {
  for (;;) {
    const v = body.slice(0, 4) + digits(body.length - 8) + body.slice(body.length - 4);
    if (v !== body) return v;
  }
}

test('every generated EVM first-4 and last-4 variant is flagged', () => {
  const body = digits(40);
  const book = [`evm:84532:0x${body}`];
  let detected = 0;
  for (let i = 0; i < 1000; i++) {
    const r = checkLookalike(`evm:84532:0x${variant(body)}`, book);
    if (r !== null && r.kind === 'hex_ends') detected++;
  }
  console.log(`LOOKALIKE detected ${detected}/1000`);
  assert.equal(detected, 1000);
});

test('every generated 64-hex implicit variant is flagged', () => {
  const body = digits(64);
  let detected = 0;
  for (let i = 0; i < 1000; i++) if (checkLookalike(`near:${variant(body)}`, [`near:${body}`])?.kind === 'hex_ends') detected++;
  assert.equal(detected, 1000);
});

test('every generated ETH-implicit variant is flagged', () => {
  const body = digits(40);
  let detected = 0;
  for (let i = 0; i < 1000; i++) if (checkLookalike(`near:0x${variant(body)}`, [`near:0x${body}`])?.kind === 'hex_ends') detected++;
  assert.equal(detected, 1000);
});

test('100,000 random EVM keys against a 50-entry random book: fewer than 100 flagged', () => {
  const book: string[] = [];
  for (let i = 0; i < 50; i++) book.push(`evm:84532:0x${digits(40)}`);
  let flagged = 0;
  for (let i = 0; i < 100000; i++) if (checkLookalike(`evm:84532:0x${digits(40)}`, book) !== null) flagged++;
  console.log(`LOOKALIKE fp ${flagged}/100000`);
  assert.ok(flagged < 100);
});

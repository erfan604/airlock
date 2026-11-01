// sanitizeUntrusted (AIR-183): the pure core of the Specimen. Every special character is written as a JavaScript escape so this
// source file stays ASCII.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INVISIBLE, sanitizeUntrusted } from '../src/components/sanitize.ts';

const token = (cp: number): string => `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;

test('sanitize: a mix of invisible characters becomes visible tokens and the newline stays', () => {
  const out = sanitizeUntrusted('a\u200Bb\u202Ec\u0007d\ne');
  assert.equal(out.shown, 'a<U+200B>b<U+202E>c<U+0007>d\ne');
  assert.equal(out.total, 9);
});

test('sanitize: each listed code point alone comes back as its token', () => {
  const cps: number[] = [
    0x0009, 0x000d, 0x007f, 0x0085, 0x00ad, 0x034f, 0x061c, 0x180b, 0x180e, 0x2028, 0x2029, 0x206a, 0x206f, 0x3164, 0xfe00, 0xfe0f,
    0xfeff, 0xffa0, 0xfff9, 0xfffb, 0xe0001, 0xe0041, 0xe0100, 0x0378, 0xe000,
  ];
  const ranges: Array<[number, number]> = [
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x2069],
  ];
  for (const [lo, hi] of ranges) for (let cp = lo; cp <= hi; cp++) cps.push(cp);
  for (const cp of cps) {
    assert.equal(sanitizeUntrusted(String.fromCodePoint(cp)).shown, token(cp), `U+${cp.toString(16)}`);
  }
  // a lone surrogate
  assert.equal(sanitizeUntrusted('\uD800').shown, '<U+D800>');
  // five digits stay five digits
  assert.equal(sanitizeUntrusted('\u{E0041}').shown, '<U+E0041>');
});

test('sanitize: the Tag block spelling of a word leaves no hidden word behind', () => {
  assert.equal(sanitizeUntrusted('\u{E0070}\u{E0061}\u{E0079}').shown, '<U+E0070><U+E0061><U+E0079>');
});

test('sanitize: ordinary text is unchanged', () => {
  for (const s of ['a', 'Z', '5', ' ', '\u00E9', '\u4E2D', '\u{1F600}', '\n']) {
    assert.equal(sanitizeUntrusted(s).shown, s, JSON.stringify(s));
  }
});

test('sanitize: a ZWJ emoji sequence shows its joiner as a token (accepted side effect)', () => {
  assert.equal(sanitizeUntrusted('\u{1F468}\u200D\u{1F469}').shown, '\u{1F468}<U+200D>\u{1F469}');
});

test('sanitize: total counts code points of the input, not UTF-16 units', () => {
  assert.equal(sanitizeUntrusted('\u{1F600}\u{1F600}').total, 2);
  assert.equal(sanitizeUntrusted('').total, 0);
});

test('sanitize: no code point from 0 to 0x10FFFF leaves an invisible character in the output', () => {
  const bad = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Cn}\p{Co}]/u;
  const leaks: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp === 0x0a || (cp >= 0xd800 && cp <= 0xdfff)) continue;
    const shown = sanitizeUntrusted(String.fromCodePoint(cp)).shown;
    if (bad.test(shown)) leaks.push(cp);
  }
  assert.deepEqual(leaks, []);
  assert.ok(INVISIBLE.flags.includes('g') && INVISIBLE.flags.includes('u'));
});

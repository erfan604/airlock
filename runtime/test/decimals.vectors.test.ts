// AIR-123: the shared decimal vectors of AIR-024 (`decimals` section of fixtures/verdict-vectors.json), which the Rust
// decimal module (AIR-027) reads too. The vectors are the source of truth: if this module and a vector disagree, the
// module is wrong. Each vector is its own test(); the summary line is printed after every vector was asserted.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AmountError, formatBaseUnits, parseCanonicalDecimal } from '../src/money/index.ts';

interface AcceptVector {
  amount: string;
  decimals: number;
  text: string;
}
interface RejectVector {
  text: string;
  decimals: number;
}
const file = JSON.parse(readFileSync(new URL('../../fixtures/verdict-vectors.json', import.meta.url), 'utf8')) as {
  decimals: { accept: AcceptVector[]; reject: RejectVector[] };
};
const { accept, reject } = file.decimals;

let acceptChecked = 0;
let rejectChecked = 0;

test('the decimals section has the two arrays', () => {
  assert.ok(Array.isArray(accept) && accept.length >= 3);
  assert.ok(Array.isArray(reject) && reject.length >= 8);
});

accept.forEach((v, i) => {
  test(`accept vector ${i}: ${JSON.stringify(v.text)} at ${v.decimals}`, () => {
    assert.equal(parseCanonicalDecimal(v.text, v.decimals), BigInt(v.amount));
    assert.equal(formatBaseUnits(BigInt(v.amount), v.decimals), v.text);
    acceptChecked += 1;
  });
});

reject.forEach((v, i) => {
  test(`reject vector ${i}: ${JSON.stringify(v.text)} at ${v.decimals}`, () => {
    assert.throws(() => parseCanonicalDecimal(v.text, v.decimals), AmountError);
    rejectChecked += 1;
  });
});

after(() => {
  assert.equal(acceptChecked, accept.length, 'every accept vector was asserted');
  assert.equal(rejectChecked, reject.length, 'every reject vector was asserted');
  console.log(`DECIMAL_VECTORS accept=${acceptChecked} reject=${rejectChecked}`);
});

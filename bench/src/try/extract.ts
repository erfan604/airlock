// The offline stand-in for the hijacked reader of `pnpm try` (AIR-256). No model: a regular expression plays the extraction step of a reader that
// did whatever the text said. Its output goes through the real interpreter, which labels it `Untrusted:quarantine` like any extraction.

/** A NEAR account id of the two testnet or mainnet suffixes, or `0x` and 40 hex digits. Keys are lower case, so an upper-case id does not match. */
const PAYEE = /(?<![A-Za-z0-9_.-])(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:testnet|near)(?![A-Za-z0-9_-]|\.[a-z0-9_-])|0x[0-9a-fA-F]{40}(?![0-9a-fA-F]))/;
const AMOUNT = /[0-9]+(?:\.[0-9]+)?/;

export interface DemoExtraction {
  /** the first account id or hex address of the text, as written */
  payee: string | null;
  /** the first number of the text (outside the payee match), as written */
  amount: string | null;
}

/**
 * The first payee and the first number of `text`. The payee match is blanked out before the amount is searched, so the digits of `acct2.testnet`
 * or of an address are never read as the amount; an integer that comes first elsewhere, the 7 of `Invoice 7: 9.4 NEAR`, is the amount.
 */
export function demoExtract(text: string): DemoExtraction {
  const m = PAYEE.exec(text);
  const rest = m === null ? text : `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
  const a = AMOUNT.exec(rest);
  return { payee: m === null ? null : m[0], amount: a === null ? null : a[0] };
}

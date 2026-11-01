// Makes invisible and risky characters of outsider text visible (DESIGN.md 3.5 rule 5, pinned by AIR-183 and AIR-181).
// Unicode property classes, not a hand-written list (REUSE_general W3): format, control, line and paragraph separator,
// unassigned, private use and lone surrogate, plus the fillers that render blank, the Mongolian selectors and the variation
// selectors. It covers the bidi controls, zero-width characters, U+2028 and U+2029, the Tag block (invisible text smuggling),
// the C0 and C1 controls and U+00AD. A code point assigned in a later Unicode version shows as a token until the runtime's ICU
// knows it (the safe direction), and a ZWJ emoji sequence shows its U+200D as a token (accepted for text shown verbatim).
// The flags are g and u: use it with `String.prototype.replace`, never with `.test`, which would keep a `lastIndex`.
export const INVISIBLE = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Cn}\p{Co}\p{Cs}\u{034F}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{180B}-\u{180D}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** `<U+XXXX>`: uppercase hex, at least four digits. */
export function codePointToken(cp: number): string {
  return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** The number of code points: a surrogate pair counts once, a lone surrogate counts once. No allocation, so a huge text is cheap. */
export function countCodePoints(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const hi = text.charCodeAt(i);
    if (hi >= 0xd800 && hi <= 0xdbff) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

/** The first `count` code points of `text` (all of it when it is shorter). */
export function takeCodePoints(text: string, count: number): string {
  let n = 0;
  let i = 0;
  while (i < text.length && n < count) {
    const hi = text.charCodeAt(i);
    const lo = text.charCodeAt(i + 1);
    i += hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff ? 2 : 1;
    n += 1;
  }
  return text.slice(0, i);
}

/** Replaces every INVISIBLE code point with its token and keeps the newline. `total` is the number of code points of `text`. */
export function sanitizeUntrusted(text: string): { shown: string; total: number } {
  const shown = text.replace(INVISIBLE, (ch) => (ch === '\n' ? ch : codePointToken(ch.codePointAt(0) as number)));
  return { shown, total: countCodePoints(text) };
}

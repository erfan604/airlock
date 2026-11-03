// Terminal safety for `pnpm try` (AIR-256): every string that came from pasted text or a case file is printed through this. The class is the one
// of the console's `sanitizeUntrusted` (web/src/components/sanitize.ts, AIR-183): format, control, line and paragraph separator, unassigned,
// private use and lone surrogate characters, the blank fillers, the Mongolian and variation selectors. It covers C0 and C1 controls (ESC among
// them), U+007F, the bidi controls, zero-width characters and the Tag block. Each becomes a visible `<U+XXXX>` token; a newline is kept.
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Cn}\p{Co}\p{Cs}\u{034F}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{180B}-\u{180D}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** `<U+XXXX>`: uppercase hex, at least four digits. */
export function codePointToken(cp: number): string {
  return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** The text with every invisible or control code point shown as a token, newlines kept. The result contains no control character but `\n`. */
export function escapeForTerminal(text: string): string {
  return text.replace(INVISIBLE, (ch) => (ch === '\n' ? ch : codePointToken(ch.codePointAt(0) as number)));
}

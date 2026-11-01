// The typed boundary for text an outsider wrote (DESIGN.md 3.5 and 6.2). An Untrusted is opaque: its text is a `#` private
// field, so it is not assignable to or from `string`, `String(u)` and `JSON.stringify(u)` never show the text, and a React
// child of this type throws instead of rendering. Text enters through `wrapUntrusted` and leaves through `revealUntrusted`;
// ESLint `no-restricted-imports` (eslint.config.js) lets only the files named there call them.

const GUARD = Symbol('Untrusted');

// set once by the static block of the class: the only code that can reach the private field and the private constructor
let wrap: (text: string) => Untrusted;
let read: (u: Untrusted) => string;

export class Untrusted {
  readonly #text: string;

  // TypeScript-private, and guarded at run time: only this module holds GUARD, so `new Untrusted('x')` cannot be written elsewhere
  private constructor(text: string, guard: symbol) {
    if (guard !== GUARD) throw new TypeError('Untrusted is made by wrapUntrusted only');
    this.#text = text;
  }

  toString(): string {
    return '[Untrusted]';
  }

  toJSON(): string {
    return '[Untrusted]';
  }

  static #wrap(text: string): Untrusted {
    return new Untrusted(text, GUARD);
  }

  static #read(u: Untrusted): string {
    return u.#text;
  }

  static {
    wrap = Untrusted.#wrap;
    read = Untrusted.#read;
  }
}

/** Null unless `raw` is a string: an outsider's number, object or null never becomes display text. */
export function wrapUntrusted(raw: unknown): Untrusted | null {
  return typeof raw === 'string' ? wrap(raw) : null;
}

/** The text, for `Specimen` only (the lint rule). Everything else shows typed values. */
export function revealUntrusted(u: Untrusted): string {
  if (!(u instanceof Untrusted)) throw new TypeError('not an Untrusted');
  return read(u);
}

// The address-book alias rule, shared by the interpreter (a `lookup` step) and the analyzer. A label is display text in the
// contract and is used for matching here, in the runtime, never on chain. An ambiguous alias is a lookup miss, so it fails closed.

/** The `get_book` view of one entry; u128 values are decimal strings. */
export type BookEntryJson = { cap: string | null; daily_untrusted_budget: string; daily_limit: string; label: string };

export type BookRows = ReadonlyArray<readonly [key: string, entry: BookEntryJson]>;

const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
};

/**
 * The payee key `name` names, or undefined. Any non-ASCII character in `name` is a miss, checked before any folding (the Kelvin
 * sign lowercases to a k). A row matches when its label, trimmed and lowercased, equals the trimmed lowercased name, or when its key
 * equals the name exactly; exactly one distinct matching key is returned, none or several give undefined. A label with a non-ASCII
 * character never matches by label, and an empty name matches nothing.
 */
export function resolveAlias(rows: BookRows, name: string): string | undefined {
  if (typeof name !== 'string' || !isAscii(name)) return undefined;
  const needle = name.trim().toLowerCase();
  if (needle === '') return undefined;
  const matches = new Set<string>();
  for (const [key, entry] of rows) {
    const label = entry.label;
    const byLabel = typeof label === 'string' && isAscii(label) && label.trim().toLowerCase() === needle;
    if (byLabel || key === name) matches.add(key);
  }
  if (matches.size !== 1) return undefined;
  return [...matches][0];
}

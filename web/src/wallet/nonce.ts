// The per-response CSP nonce, as AIR-183's preview plugin serves it: Vite's `html.cspNonce` writes `<meta property="csp-nonce" nonce="...">`
// into the page. NEAR Connect needs it as `cspNonce` for the inline script of the wallet executor iframe (REUSE_near.md R5.1). The nonce
// attribute is hidden from `getAttribute` in a browser once the page has loaded, so the `nonce` property is read first.
type NonceElement = { nonce?: string; getAttribute(name: string): string | null };

/** `doc` defaults to the page; a test passes a double. */
export function readCspNonce(doc: { querySelector(selector: string): NonceElement | null } = document): string | undefined {
  const el = doc.querySelector('meta[property="csp-nonce"]');
  if (el === null) return undefined;
  const value = el.nonce !== undefined && el.nonce !== '' ? el.nonce : el.getAttribute('nonce');
  return value !== null && value !== '' ? value : undefined;
}

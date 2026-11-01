// The console's Content-Security-Policy (AIR-183; docs/PLUMBING.md "Console CSP" gives the same header for any other host).
// Scripts: 'self' plus a per-response nonce, never unsafe-inline or unsafe-eval. Styles allow inline because NEAR Connect 0.11.4
// injects styles at runtime and a policy without them breaks the wallet picker (a measured integration finding, see
// KNOWN_LIMITATIONS). connect-src lists the runtime origin, the NEAR RPC hosts and the wallet origins and no Base RPC: the
// console never talks to Base.

/** The NEAR Connect manifest and fallback host and Intear's executor (notes/wallet_display section 0). AIR-182 confirms and extends it. */
export const WALLET_ORIGINS = ['https://raw.githubusercontent.com', 'https://cdn.jsdelivr.net', 'https://wallet.intear.tech'] as const;

/** A starting list for wallet icon images, extended by AIR-182. */
export const ICON_ORIGINS = ['https://raw.githubusercontent.com'] as const;

/** NEAR testnet regular nodes in the order of plan/STACK.md section RPC, the one place that sets it. */
export const NEAR_RPC = [
  'https://test.rpc.fastnear.com',
  'https://near-testnet.drpc.org',
  'https://testnet-rpc.intea.rs',
  'https://rpc.testnet.near.org',
] as const;

/** Paths the console and the runtime share one origin for, so the session cookie is sent (AIR-161's routes). */
export const PROXY_PATHS = ['/session', '/tasks', '/runs', '/api'] as const;

export type CspInput = {
  runtimeOrigin: string;
  nearRpc: readonly string[];
  walletOrigins: readonly string[];
  iconOrigins: readonly string[];
  nonce: string;
};

export function buildCsp(o: CspInput): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${o.nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${o.iconOrigins.join(' ')}`,
    "font-src 'self'",
    `connect-src 'self' ${o.runtimeOrigin} ${o.nearRpc.join(' ')} ${o.walletOrigins.join(' ')}`,
    `frame-src 'self' ${o.walletOrigins.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** Everything buildCsp needs except the per-response nonce. */
export type CspInputs = Omit<CspInput, 'nonce'>;

/** The origins the console is built and tested with. `VITE_RUNTIME_ORIGIN` overrides the runtime (AIR-161's port by default). */
export function defaultCspInputs(): CspInputs {
  return {
    runtimeOrigin: process.env.VITE_RUNTIME_ORIGIN ?? 'http://localhost:8787',
    nearRpc: NEAR_RPC,
    walletOrigins: WALLET_ORIGINS,
    iconOrigins: ICON_ORIGINS,
  };
}

/** Every `'nonce-<value>'` becomes `'nonce-NONCE'`: the nonce differs per response, so two policies compare only after this. */
export function normalizeNonce(policy: string): string {
  return policy.replace(/'nonce-[^']*'/g, "'nonce-NONCE'");
}

/** `preview.proxy` for the runtime paths. `changeOrigin: false` keeps Host, so the cookie belongs to the console origin. */
export function previewProxy(runtimeOrigin: string): Record<string, { target: string; changeOrigin: false }> {
  return Object.fromEntries(PROXY_PATHS.map((p) => [p, { target: runtimeOrigin, changeOrigin: false as const }]));
}

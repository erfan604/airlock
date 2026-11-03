// The console's Content-Security-Policy (AIR-183; docs/PLUMBING.md "Console CSP" gives the same header for any other host).
// Scripts: 'self' plus a per-response nonce, never unsafe-inline or unsafe-eval. Styles allow inline because NEAR Connect 0.11.4
// injects styles at runtime and a policy without them breaks the wallet picker (a measured integration finding, see
// KNOWN_LIMITATIONS). connect-src lists the runtime origin, the NEAR RPC hosts and the wallet origins and no Base RPC: the
// console never talks to Base.
import snapshot from './src/wallet/manifest-snapshot.json' with { type: 'json' };

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
export const PROXY_PATHS = ['/session', '/tasks', '/runs', '/api', '/replay'] as const;

/**
 * What a wallet's executor iframe loads beyond the origins its manifest names, measured per executor (AIR-182, headless Chromium 153,
 * 2026-10-21, each wallet clicked once in the selector). The executor inherits the page's policy, so each origin below widens it: only the
 * entry of a wallet that is in the pinned snapshot is ever added, and the primary wallet (Intear) needs none. A primary that needs one
 * adds it knowingly (docs/PLUMBING.md, reviewed by AIR-167). The Meteor and NEAR CLI rows are measured data, unused while those wallets are
 * not in the snapshot. Keyed by the manifest id.
 */
export const WALLET_UI_ORIGINS: Record<string, { img?: string[]; style?: string[]; font?: string[]; connect?: string[] }> = {
  'meteor-wallet': {
    img: ['https://meteorwallet.app'],
    style: ['https://rsms.me', 'https://fonts.cdnfonts.com'],
    font: ['https://rsms.me', 'data:'],
    connect: ['https://mc.meteorwallet.app'],
  },
  'near-cli': { font: ['https://rsms.me'] },
};

export type CspInput = {
  runtimeOrigin: string;
  nearRpc: readonly string[];
  walletOrigins: readonly string[];
  iconOrigins: readonly string[];
  nonce: string;
  /** Manifest ids of the pinned snapshot: their `WALLET_UI_ORIGINS` rows are added. Absent means none. */
  walletIds?: readonly string[];
};

const uiOrigins = (ids: readonly string[] | undefined, kind: 'img' | 'style' | 'font' | 'connect'): string[] => {
  const out: string[] = [];
  for (const id of ids ?? []) {
    if (!Object.hasOwn(WALLET_UI_ORIGINS, id)) continue;
    for (const origin of WALLET_UI_ORIGINS[id]?.[kind] ?? []) if (!out.includes(origin)) out.push(origin);
  }
  return out;
};

const join = (base: string, extra: readonly string[]): string => [base, ...extra].join(' ');

export function buildCsp(o: CspInput): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${o.nonce}'`,
    join("style-src 'self' 'unsafe-inline'", uiOrigins(o.walletIds, 'style')),
    join(`img-src 'self' data: ${o.iconOrigins.join(' ')}`, uiOrigins(o.walletIds, 'img')),
    join("font-src 'self'", uiOrigins(o.walletIds, 'font')),
    join(`connect-src 'self' ${o.runtimeOrigin} ${o.nearRpc.join(' ')} ${o.walletOrigins.join(' ')}`, uiOrigins(o.walletIds, 'connect')),
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
    walletIds: snapshot.wallets.map((w) => w.id),
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

/**
 * AIR-310: the policy of the static build (`web/dist-static`). It is the preview policy with everything the replay never uses taken away: the
 * runtime origin, the NEAR RPC hosts, the wallet origins and the wallet frames are gone, so the page can talk to its own origin only. There is no
 * nonce because the built page has no inline script (a module script by `src` only). `frame-ancestors` cannot be set from a meta tag, so it is
 * in the header form only (`_headers`); a host that ignores `_headers` (GitHub Pages) still gets everything else from the meta tag.
 */
export function buildStaticCsp(opts: { header: boolean }): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    ...(opts.header ? ["frame-ancestors 'none'"] : []),
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

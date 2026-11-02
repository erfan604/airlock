// Checks the pinned wallet snapshot against the console CSP (AIR-182): the origin of every executor must be in connect-src and frame-src,
// and the origin of every icon that is not a data: URI in img-src. Prints `WALLET ORIGINS OK (<n> origins)` or each missing origin and exits 1.
// Usage: tsx scripts/check-wallet-origins.ts
import { pathToFileURL } from 'node:url';
import { buildCsp, defaultCspInputs } from '../csp.ts';
import snapshot from '../src/wallet/manifest-snapshot.json' with { type: 'json' };

type Manifest = { wallets: { id: string; executor: string; icon: string }[] };

function directive(policy: string, name: string): Set<string> {
  const line = policy
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));
  return new Set(line === undefined ? [] : line.split(/\s+/).slice(1));
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** `missing` has one line per (origin, directive) the policy lacks; `origins` counts the distinct origins the snapshot needs. */
export function checkWalletOrigins(manifest: Manifest, policy: string): { origins: number; missing: string[] } {
  const connect = directive(policy, 'connect-src');
  const frame = directive(policy, 'frame-src');
  const img = directive(policy, 'img-src');
  const needed = new Set<string>();
  const missing: string[] = [];
  for (const w of manifest.wallets) {
    const exec = originOf(w.executor);
    if (exec === null) {
      missing.push(`${w.id}: executor ${w.executor} is not an http(s) URL`);
    } else {
      needed.add(exec);
      if (!connect.has(exec)) missing.push(`${w.id}: ${exec} (executor) is not in connect-src`);
      if (!frame.has(exec)) missing.push(`${w.id}: ${exec} (executor) is not in frame-src`);
    }
    if (!w.icon.startsWith('data:')) {
      const icon = originOf(w.icon);
      if (icon === null) {
        missing.push(`${w.id}: icon ${w.icon.slice(0, 60)} is neither a data: URI nor an http(s) URL`);
      } else {
        needed.add(icon);
        if (!img.has(icon)) missing.push(`${w.id}: ${icon} (icon) is not in img-src`);
      }
    }
  }
  return { origins: needed.size, missing };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkWalletOrigins(snapshot, buildCsp({ ...defaultCspInputs(), nonce: 'x' }));
  if (result.missing.length > 0) {
    for (const m of result.missing) console.error(`WALLET ORIGINS MISSING: ${m}`);
    process.exit(1);
  }
  console.log(`WALLET ORIGINS OK (${result.origins} origins)`);
}

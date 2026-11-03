// The network side of AIR-303: fetch a report with a fresh nonce and verify it with the Intel DCAP library and NVIDIA NRAS. The key comes from the
// environment of the caller (`NEARAI_API_KEY`), is sent as a bearer header and appears nowhere else. No key, no report or an HTTP error ends as an
// UNATTESTED record (fail closed, never silent).
import { randomBytes } from 'node:crypto';
import * as dcap from '@phala/dcap-qvl';
import { unattested, verifyReport } from './verify.ts';
import type { Attestation, GpuVerifier, QuoteVerifier, VerifiedQuote, VerifyDeps, VerifyPolicy } from './types.ts';
import { DEFAULT_POLICY } from './types.ts';

export const REPORT_URL = 'https://cloud-api.near.ai/v1/attestation/report';
export const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const TIMEOUT_MS = 60_000;

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** Reads the fields the checks need from a DCAP-verified TDX quote. */
export function readQuote(v: { status: string; advisory_ids: string[]; report: { type: string; data: Record<string, Uint8Array> } }): VerifiedQuote {
  if (v.report.type !== 'td10') throw new Error('expected a TDX (td10) quote');
  const d = v.report.data;
  const need = (k: string): string => {
    const x = d[k];
    if (x === undefined) throw new Error(`quote has no ${k}`);
    return toHex(x);
  };
  return {
    status: v.status,
    advisory_ids: [...v.advisory_ids],
    td_attributes: need('tdAttributes'),
    report_data: need('reportData'),
    mr_config_id: need('mrConfigId'),
    rtmr3: need('rtMr3'),
    mr_td: need('mrTd'),
  };
}

/** The collateral of a quote, fetched from Phala's PCCS (the library default) and checked against Intel's root key by `verify`. */
export interface Collateral {
  [k: string]: unknown;
}
type Verified = Parameters<typeof readQuote>[0];

/** DCAP verification of one quote at `nowSecs` with the given collateral. */
export function verifyWithCollateral(quoteHex: string, collateral: Collateral, nowSecs: number): VerifiedQuote {
  const verify = dcap.verify as unknown as (q: Buffer, c: Collateral, n: number) => Verified;
  return readQuote(verify(Buffer.from(quoteHex, 'hex'), collateral, nowSecs));
}

/** The live quote verifier. `record` receives each quote's collateral and the time used, so a run can be stored as a fixture. */
export function liveQuoteVerifier(now: () => Date, record?: (quoteHex: string, collateral: Collateral, nowSecs: number) => void): QuoteVerifier {
  return async (quoteHex) => {
    const collateral = (await dcap.getCollateral(dcap.PHALA_PCCS_URL, Buffer.from(quoteHex, 'hex'))) as unknown as Collateral;
    const nowSecs = Math.floor(now().getTime() / 1000);
    record?.(quoteHex, collateral, nowSecs);
    return verifyWithCollateral(quoteHex, collateral, nowSecs);
  };
}

/** NVIDIA NRAS: the decoded payload goes in unchanged; the first entry is `["JWT", token]` and its payload carries `x-nvidia-overall-att-result`. */
export function liveGpuVerifier(fetchFn: typeof fetch = fetch, record?: (payload: unknown, response: unknown) => void): GpuVerifier {
  return async (payload) => {
    const res = await fetchFn(NRAS_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`NRAS answered HTTP ${res.status}`);
    const json: unknown = await res.json();
    record?.(payload, json);
    return nrasVerdict(json);
  };
}

/** The overall verdict of an NRAS response; anything malformed is false. */
export function nrasVerdict(json: unknown): boolean {
  if (!Array.isArray(json)) return false;
  const first: unknown = json[0];
  if (!Array.isArray(first) || first[0] !== 'JWT' || typeof first[1] !== 'string') return false;
  const part = first[1].split('.')[1];
  if (part === undefined) return false;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    return claims['x-nvidia-overall-att-result'] === true;
  } catch {
    return false;
  }
}

export interface FetchOpts {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
  nonce?: string;
  policy?: VerifyPolicy;
  deps?: Partial<VerifyDeps>;
  /** receives the raw body of the report that was fetched (fixture recording) */
  onBody?: (rawBody: string, nonce: string) => void;
}

/** Fetch with a fresh nonce and verify. Never throws; every failure is an UNATTESTED or FAILED record. */
export async function attestModel(model: string, opts: FetchOpts = {}): Promise<Attestation> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const f = opts.fetch ?? fetch;
  const nonce = opts.nonce ?? randomBytes(32).toString('hex');
  const key = env.NEARAI_API_KEY;
  if (key === undefined || key === '') return unattested(model, nonce, 'no NEARAI_API_KEY in the environment', now());
  const url = `${REPORT_URL}?${new URLSearchParams({ model, provider: 'near', signing_algo: 'ecdsa', nonce })}`;
  let rawBody: string;
  try {
    const res = await f(url, {
      headers: { Accept: 'application/json', 'x-no-aliasing': 'true', Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return unattested(model, nonce, `attestation report request answered HTTP ${res.status}`, now());
    rawBody = await res.text();
  } catch (e) {
    return unattested(model, nonce, `attestation report request failed: ${e instanceof Error ? e.name : 'error'}`, now());
  }
  opts.onBody?.(rawBody, nonce);
  const deps: VerifyDeps = {
    verifyQuote: opts.deps?.verifyQuote ?? liveQuoteVerifier(now),
    verifyGpu: opts.deps?.verifyGpu ?? liveGpuVerifier(f),
    now,
  };
  return verifyReport({ rawBody, model, nonce }, deps, opts.policy ?? DEFAULT_POLICY);
}

// Verification of a NEAR AI Cloud attestation report (AIR-303), written from the prose of docs.near.ai/cloud/verification (gateway-attestation,
// model-attestations, reference/quote-nonce-signer, reference/verification-policy; read 2026-11-03). Every check is a named row; a check that
// cannot run is a failed row, never a skipped one (the policy page: "treat required checks as fail-closed"). Nothing here throws on bad input:
// a report that is malformed fails the check that reads it.
import { createHash } from 'node:crypto';
import { DEFAULT_POLICY } from './types.ts';
import type { Attestation, Check, VerifiedQuote, VerifyDeps, VerifyPolicy } from './types.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const sha = (alg: 'sha256' | 'sha384', ...parts: (Buffer | string)[]): Buffer => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return h.digest();
};
const hexBytes = (s: string): Buffer => {
  const t = s.replace(/^0x/i, '');
  if (t.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(t)) throw new Error('not hex');
  return Buffer.from(t, 'hex');
};
const asObject = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const jsonIfText = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs one check; a throw is a failed row carrying the reason. */
async function row(name: string, fn: () => Promise<string> | string): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (e) {
    return { name, ok: false, detail: msg(e) };
  }
}

/** The RTMR3 a report's event log replays to: SHA-384 extended over the imr 3 events in order (docs, "Replay the RTMR3 event log"). */
export function replayRtmr3(eventLog: unknown): Buffer {
  const events = jsonIfText(eventLog);
  if (!Array.isArray(events)) throw new Error('event_log is not a list');
  let rtmr3: Buffer = Buffer.alloc(48);
  for (const raw of events) {
    const e = asObject(raw);
    if (e === null) throw new Error('event is not an object');
    if (e.imr !== 3) continue;
    if (typeof e.event_type !== 'number' || typeof e.event !== 'string') throw new Error('event without type or name');
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type);
    const payload = typeof e.event_payload === 'string' ? e.event_payload : '';
    const digest = sha('sha384', type, ':', Buffer.from(e.event, 'utf8'), ':', hexBytes(payload));
    if (typeof e.digest === 'string' && e.digest !== '' && !hexBytes(e.digest).equals(digest)) throw new Error(`digest mismatch for event ${e.event}`);
    rtmr3 = sha('sha384', rtmr3, digest);
  }
  return rtmr3;
}

/** The raw `app_compose` string of a report (tcb_info is an object or JSON text), hashed as its exact UTF-8 bytes. */
function composeHashOf(report: Record<string, unknown>): string {
  const info = asObject(report.info);
  const tcb = asObject(jsonIfText(info?.tcb_info));
  const compose = tcb?.app_compose;
  if (typeof compose !== 'string') throw new Error('no info.tcb_info.app_compose');
  return sha('sha256', Buffer.from(compose, 'utf8')).toString('hex');
}

/** The quote-level checks shared by the gateway report and the model report. */
async function quoteChecks(
  who: 'gateway' | 'model',
  report: Record<string, unknown> | null,
  nonce: string,
  deps: VerifyDeps,
  policy: VerifyPolicy,
): Promise<{ checks: Check[]; quote: VerifiedQuote | null }> {
  const p = (n: string) => `${who}.${n}`;
  if (report === null) return { checks: [{ name: p('report'), ok: false, detail: 'missing or not an object' }], quote: null };
  const checks: Check[] = [];
  let quote: VerifiedQuote | null = null;
  const q = await row(p('quote'), async () => {
    if (typeof report.intel_quote !== 'string') throw new Error('no intel_quote');
    quote = await deps.verifyQuote(report.intel_quote);
    if (!policy.acceptedTcb.includes(quote.status)) throw new Error(`TCB status ${quote.status} is not accepted (advisories: ${quote.advisory_ids.join(',') || 'none'})`);
    return `Intel DCAP signature chain and collateral verified, TCB ${quote.status}`;
  });
  checks.push(q);
  if (quote === null) return { checks, quote: null };
  const v: VerifiedQuote = quote;
  checks.push(await row(p('td_debug_off'), () => {
    const attrs = hexBytes(v.td_attributes);
    if (attrs.length === 0 || (attrs[0] ?? 1) & 1) throw new Error('TDX debug mode is enabled');
    return 'TD_ATTRIBUTES debug bit is clear';
  }));
  checks.push(await row(p('nonce_echo'), () => {
    if (typeof report.request_nonce !== 'string' || report.request_nonce.toLowerCase() !== nonce) throw new Error('echoed request_nonce differs from the nonce this client generated');
    return 'request_nonce equals the client nonce';
  }));
  checks.push(await row(p('report_data'), () => {
    const algo = report.signing_algo;
    if (typeof report.signing_address !== 'string') throw new Error('no signing_address');
    const id = hexBytes(report.signing_address);
    const want = algo === 'ecdsa' ? 20 : algo === 'ed25519' ? 32 : -1;
    if (id.length !== want) throw new Error(`signing identity does not fit signing_algo ${String(algo)}`);
    const bound = Buffer.concat([id, Buffer.alloc(32 - id.length)]);
    const expected = Buffer.concat([bound, hexBytes(nonce)]).toString('hex');
    if (v.report_data !== expected) throw new Error('verified quote report data does not bind the signing address and the nonce');
    return 'the verified quote binds the signing address and our nonce';
  }));
  checks.push(await row(p('event_log'), () => {
    if (replayRtmr3(report.event_log).toString('hex') !== v.rtmr3) throw new Error('replayed event log differs from RTMR3 of the verified quote');
    return 'event log replays to the quote RTMR3';
  }));
  checks.push(await row(p('mrconfigid'), () => {
    const hash = composeHashOf(report);
    const expected = Buffer.concat([Buffer.from([1]), Buffer.from(hash, 'hex'), Buffer.alloc(15)]).toString('hex');
    if (v.mr_config_id !== expected) throw new Error('MRCONFIGID of the verified quote differs from the hash of app_compose');
    return `MRCONFIGID equals 01 plus sha256(app_compose) ${hash.slice(0, 16)}`;
  }));
  return { checks, quote };
}

export interface VerifyInput {
  /** the raw HTTP response body of GET /v1/attestation/report, as received */
  rawBody: string;
  /** the model id requested (canonical, sent with x-no-aliasing) */
  model: string;
  /** the nonce this client generated for the request */
  nonce: string;
}

/** Verifies a fetched report. Never throws; the result is VERIFIED only when every row is ok. */
export async function verifyReport(input: VerifyInput, deps: VerifyDeps, policy: VerifyPolicy = DEFAULT_POLICY): Promise<Attestation> {
  const nonce = input.nonce.toLowerCase();
  const reportSha = sha('sha256', Buffer.from(input.rawBody, 'utf8')).toString('hex');
  const out: Attestation = {
    model: input.model,
    nonce,
    report_sha256: reportSha,
    verified_at: deps.now().toISOString(),
    status: 'FAILED',
    checks: [],
    signing_address: null,
    tcb_status: null,
    compose_hash: null,
    source: 'live',
  };
  out.checks.push(await row('nonce_format', () => {
    if (!HEX64.test(nonce)) throw new Error('nonce is not 32 bytes as 64 hex characters');
    return '32 random bytes, 64 hex characters';
  }));
  const parsed = await row('report_parsed', () => {
    if (asObject(JSON.parse(input.rawBody)) === null) throw new Error('response is not a JSON object');
    return `response body sha256 ${reportSha.slice(0, 16)}`;
  });
  out.checks.push(parsed);
  const b: Record<string, unknown> | null = parsed.ok ? asObject(JSON.parse(input.rawBody)) : null;
  const gateway = await quoteChecks('gateway', asObject(b?.gateway_attestation), nonce, deps, policy);
  out.checks.push(...gateway.checks);

  const candidates = Array.isArray(b?.model_attestations) ? (b.model_attestations as unknown[]) : [];
  out.checks.push(await row('model.present', () => {
    if (candidates.length === 0) throw new Error('model_attestations is missing or empty');
    return `${candidates.length} model report candidate(s) returned, each one is checked`;
  }));
  // every returned candidate is verified (docs: "verify every returned candidate"); the record names the first one's identity
  for (const [i, c] of candidates.entries()) {
    const rep = asObject(c);
    const tag = candidates.length > 1 ? `model[${i}]` : 'model';
    const named = await row(`${tag}.id`, () => {
      if (rep?.model_name !== input.model) throw new Error(`report is for ${String(rep?.model_name)}, not ${input.model}`);
      return `model_name equals ${input.model}`;
    });
    out.checks.push(named);
    const m = await quoteChecks('model', rep, nonce, deps, policy);
    out.checks.push(...m.checks.map((k) => ({ ...k, name: k.name.replace(/^model\./, `${tag}.`) })));
    out.checks.push(await row(`${tag}.gpu`, async () => {
      if (rep === null || typeof rep.nvidia_payload !== 'string') throw new Error('no nvidia_payload (GPU evidence is required)');
      const payload = asObject(JSON.parse(rep.nvidia_payload));
      if (payload === null || typeof payload.nonce !== 'string' || payload.nonce.toLowerCase() !== nonce) throw new Error('GPU evidence nonce differs from the client nonce');
      if (!(await deps.verifyGpu(payload))) throw new Error('NVIDIA NRAS overall attestation result is not true');
      return 'GPU evidence carries our nonce and NVIDIA NRAS reports an overall pass';
    }));
    if (policy.acceptedComposeHashes !== undefined) {
      out.checks.push(await row(`${tag}.allowlist`, () => {
        const hash = composeHashOf(rep ?? {});
        if (!policy.acceptedComposeHashes?.includes(hash)) throw new Error(`compose hash ${hash} is not in the allowlist`);
        return 'compose hash is in the allowlist';
      }));
    }
    if (i === 0) {
      out.signing_address = typeof rep?.signing_address === 'string' ? rep.signing_address : null;
      out.tcb_status = m.quote?.status ?? null;
      if (m.quote !== null) {
        const id = Buffer.from(m.quote.mr_config_id, 'hex');
        out.compose_hash = id.length === 48 ? id.subarray(1, 33).toString('hex') : null;
      }
    }
  }
  out.status = out.checks.every((c) => c.ok) ? 'VERIFIED' : 'FAILED';
  return out;
}

/** The record for a fetch that produced no report at all: nothing was checked, and the record says so. */
export function unattested(model: string, nonce: string, reason: string, now: Date): Attestation {
  return {
    model,
    nonce,
    report_sha256: '',
    verified_at: now.toISOString(),
    status: 'UNATTESTED',
    checks: [{ name: 'report_fetched', ok: false, detail: reason }],
    signing_address: null,
    tcb_status: null,
    compose_hash: null,
    source: 'live',
  };
}

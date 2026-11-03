// The `Verified` panel of the approval view (AIR-303): what was checked about the private model the agent reasons on, one row per check, taken
// from the runtime's GET /api/attestation. It prints the checks and what they found, never a verdict word of its own beyond the three statuses
// the verifier returns. A record with source `recorded` says so: a replay shows the stored result of one live check and does not repeat it.
import type { Attestation } from '@airlock/runtime/attest';

const short = (hex: string): string => (hex === '' ? 'none' : `${hex.slice(0, 16)}...`);

function summary(a: Attestation): string {
  const failed = a.checks.filter((c) => !c.ok).length;
  if (a.status === 'VERIFIED') return `All ${a.checks.length} checks passed.`;
  if (a.status === 'UNATTESTED') return 'Not attested: no report could be fetched, so nothing was checked.';
  return `Not verified: ${failed} of ${a.checks.length} checks failed.`;
}

export function VerifiedPanel({ attestations }: { attestations: readonly Attestation[] }) {
  if (attestations.length === 0) return null;
  return (
    <section className="verified-panel" data-testid="verified-panel" aria-labelledby="verified-title">
      <h2 className="verified-title" id="verified-title">
        Verified
      </h2>
      {attestations.map((a) => (
        <div className="verified-record" data-testid="verified-record" data-status={a.status} key={`${a.model}:${a.nonce}`}>
          <p className="verified-line" data-testid="verified-summary">
            <span className="verified-model">{a.model}</span>
            {` ${a.status}. ${summary(a)}`}
          </p>
          <dl className="verified-facts">
            <dt>Report hash</dt>
            <dd data-testid="verified-hash" title={a.report_sha256}>{short(a.report_sha256)}</dd>
            <dt>Checked</dt>
            <dd>{`${a.verified_at}${a.source === 'recorded' ? ' (recorded result, not repeated here)' : ''}`}</dd>
            {a.tcb_status === null ? null : (
              <>
                <dt>Intel TCB</dt>
                <dd>{a.tcb_status}</dd>
              </>
            )}
            {a.nonce === '' ? null : (
              <>
                <dt>Nonce</dt>
                <dd>{short(a.nonce)}</dd>
              </>
            )}
          </dl>
          <ul className="verified-checks" data-testid="verified-checks">
            {a.checks.map((c) => (
              <li className="verified-check" data-ok={c.ok} key={c.name}>
                <span className="verified-mark">{c.ok ? 'pass' : 'fail'}</span>
                <span className="verified-name">{c.name}</span>
                <span className="verified-detail">{c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

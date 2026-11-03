// GET /api/attestation (AIR-303): the attestation records of the models the agent reasons on, behind the owner session. Each record is the output of
// `verifyReport` (named checks, the sha256 of the verified report, the verification time) or an UNATTESTED record that says nothing was checked.
// A runtime with no source answers one UNATTESTED record, never an empty list, so the console always has something true to print.
import type { Hono } from 'hono';
import { unattested } from '../attest/index.ts';
import type { Attestation } from '../attest/index.ts';
import { requireSession } from './session.ts';

export interface AttestationSource {
  /** the latest record per model, in the order the roles use them (planner first) */
  current(): Attestation[];
}

export function mountAttestation(app: Hono, source: AttestationSource | undefined, clock: () => number): void {
  app.get('/api/attestation', requireSession, (c) => {
    const records = source?.current() ?? [];
    if (records.length > 0) return c.json({ attestations: records });
    return c.json({ attestations: [unattested('unknown', '', 'this runtime holds no attestation record', new Date(clock()))] });
  });
}

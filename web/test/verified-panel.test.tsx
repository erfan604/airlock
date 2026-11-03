// AIR-303: the Verified panel prints every check of the recorded attestation, names the three statuses, and never uses the banned word.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Attestation } from '@airlock/runtime/attest';
import { VerifiedPanel } from '../src/approvals/VerifiedPanel.tsx';

const recorded = JSON.parse(readFileSync(new URL('../../runtime/recordings/attest/z-ai_glm-5.3-flash.json', import.meta.url), 'utf8')) as Attestation;

test('verified panel: one row per check, the hash, the time and the recorded label', () => {
  const html = renderToStaticMarkup(<VerifiedPanel attestations={[recorded]} />);
  assert.equal(html.split('verified-check"').length - 1, recorded.checks.length);
  assert.ok(html.includes('All 21 checks passed.'));
  assert.ok(html.includes(recorded.report_sha256));
  assert.ok(html.includes('recorded result, not repeated here'));
  for (const c of recorded.checks) assert.ok(html.includes(c.name), c.name);
  assert.equal(html.toLowerCase().includes('secure'), false);
});

test('verified panel: a failed check and an unattested record say so in words', () => {
  const bad: Attestation = { ...recorded, status: 'FAILED', checks: recorded.checks.map((c, i) => (i === 3 ? { ...c, ok: false, detail: 'nonce differs' } : c)) };
  const html = renderToStaticMarkup(<VerifiedPanel attestations={[bad]} />);
  assert.ok(html.includes('Not verified: 1 of 21 checks failed.'));
  assert.ok(html.includes('nonce differs'));
  assert.ok(html.includes('fail'));
  const none: Attestation = { ...recorded, status: 'UNATTESTED', report_sha256: '', nonce: '', checks: [{ name: 'report_fetched', ok: false, detail: 'no NEARAI_API_KEY in the environment' }] };
  const h2 = renderToStaticMarkup(<VerifiedPanel attestations={[none]} />);
  assert.ok(h2.includes('Not attested'));
  assert.ok(h2.includes('no NEARAI_API_KEY'));
});

test('verified panel: nothing to show renders nothing', () => {
  assert.equal(renderToStaticMarkup(<VerifiedPanel attestations={[]} />), '');
});

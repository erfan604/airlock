// Fixture routes of AIR-181: `card-correction` (the 9.4 NEAR correction held as UntrustedAmount, the state that shows the cap line) and
// `card-correction-live` (the same request held as OverTaskBound, which is what the live B01 run escalates). Both read a JSON file
// under web/fixtures/ and nothing else: no network, no wallet. The wallet of these routes fails every approve (the first as the wallet,
// the second as the contract), so the failure states can be reached by clicking. `nowMs` is fixed, so "2 min ago" is always 2 min.
import type { AssetEntryViewJson, LedgersView, RequestView } from '@airlock/runtime/chain-types';
import type { BookEntryJson } from '@airlock/runtime/dsl';
import { Card } from '../approvals/Card.tsx';
import type { ApproveResult } from '../approvals/Card.tsx';
import { parseEvidence } from '../approvals/evidence.ts';
import correction from '../../fixtures/card-correction.json' with { type: 'json' };
import live from '../../fixtures/card-correction-live.json' with { type: 'json' };
import lookalike from '../../fixtures/card-lookalike.json' with { type: 'json' };
import newHex from '../../fixtures/card-new-hex.json' with { type: 'json' };
import { registerFixture } from './registry.ts';

const SCOPE = { network: 'testnet', contractId: 'airlock-policy.testnet' };

let attempts = 0;
async function fixtureWallet(): Promise<ApproveResult> {
  attempts += 1;
  return attempts % 2 === 1 ? { ok: false, kind: 'wallet', name: 'FixtureWalletDeclined' } : { ok: false, kind: 'contract', name: 'FixtureContractRefused' };
}

type FixtureData = Omit<typeof correction, 'book'> & { book: BookEntryJson | null; bookKeys?: string[]; bookLabels?: Record<string, string> };

function CardFixture({ data }: { data: FixtureData }) {
  const view = data.view as RequestView;
  return (
    <main className="page fixture" data-testid="fixture-card">
      <Card
        view={view}
        evidence={parseEvidence(data.evidence, view.labels)}
        ledgers={data.ledgers as LedgersView}
        asset={data.asset as AssetEntryViewJson}
        book={data.book}
        bookKeys={data.bookKeys ?? []}
        bookLabels={data.bookLabels}
        onApprove={fixtureWallet}
        onReject={fixtureWallet}
        scope={SCOPE}
        nowMs={data.now_ms}
      />
    </main>
  );
}

registerFixture('card-correction', () => <CardFixture data={correction} />);
registerFixture('card-correction-live', () => <CardFixture data={live} />);
// AIR-296: the same request read back after the owner approved it and after the contract blocked it, so the approved and blocked stamps
// of the card can be reviewed (and filmed) without a wallet. Only `view.state` differs from `card-correction`.
registerFixture('card-approved', () => <CardFixture data={{ ...correction, view: { ...correction.view, state: 'Executed' } }} />);
registerFixture('card-blocked', () => <CardFixture data={{ ...correction, view: { ...correction.view, state: 'Blocked' } }} />);
// AIR-190: a payee outside the book. `card-lookalike` is a named account one letter off a book entry, `card-new-hex` an EVM address that
// shares the first and last four digits of a book key. Both ask for the forcing step in the confirm sheet.
registerFixture('card-lookalike', () => <CardFixture data={lookalike as unknown as FixtureData} />);
registerFixture('card-new-hex', () => <CardFixture data={newHex as unknown as FixtureData} />);

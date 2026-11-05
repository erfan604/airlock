// AIR-311: the request an agent built, field by field, each value with the tag of where it came from. Used by the landing's headline case and by
// the Try page. Every value here is typed system text (formatted dollars, a book name, an account id the stand-in matched by a closed
// pattern); outside text itself is shown only in the email Specimen next to it.
import type { ReactNode } from 'react';
import { Seal } from '../components/Seal.tsx';
import type { LabelKey } from '../components/Seal.tsx';
import { WORLD, formatDollars, originWords, parseDollars, wordsOf } from './model.ts';
import type { Proposal, World } from './model.ts';

function Field({ name, value, label, source, outside, children, testId }: { name: string; value: string; label: LabelKey; source: string; outside: boolean; children?: ReactNode; testId: string }) {
  return (
    <div className="slip-row" data-testid={testId} data-origin={outside ? 'outside' : 'inside'}>
      <span className="slip-name">{name}</span>
      <span className={outside ? 'slip-value slip-value-outside' : 'slip-value'}>{value}</span>
      <span className="slip-tag">
        <Seal label={label} size="S" source={source} />
      </span>
      {children}
    </div>
  );
}

/** `compact` leaves out the Because row (the Try page shows the owner's request in its setup line). */
export function RequestSlip({ proposal, world = WORLD, compact = false }: { proposal: Proposal; world?: World; compact?: boolean }) {
  const { payee, amount } = proposal;
  const entry = world.book.find((b) => b.account === payee.account);
  const usual = entry === undefined ? null : parseDollars(entry.usual);
  const outsideLabel: LabelKey = `Untrusted:${proposal.source.channel}`;
  const payeeLabel: LabelKey = payee.origin === 'owner' ? 'Book' : outsideLabel;
  return (
    <div className="slip" data-testid="request-slip">
      <Field name="Pay" value={payee.name ?? payee.account} label={payeeLabel} source={originWords(payee.origin, payee.inBook, proposal.source, world)} outside={payee.origin !== 'owner'} testId="slip-payee">
        {payee.name === null ? null : <span className="slip-sub">{payee.account}</span>}
      </Field>
      <Field name="Amount" value={formatDollars(amount.cents)} label={outsideLabel} source={originWords('email-amount', true, proposal.source, world)} outside testId="slip-amount">
        {usual === null || entry === undefined ? null : (
          <span className={usual === amount.cents ? 'slip-sub' : 'slip-sub slip-diff'} data-testid="slip-usual">
            {usual === amount.cents ? `${wordsOf(world).says} ${formatDollars(usual)} a ${entry.every}, the same.` : `${wordsOf(world).says} ${formatDollars(usual)} a ${entry.every}.`}
          </span>
        )}
      </Field>
      {compact ? null : <Field name="Because" value={`You asked: ${world.owner.request}`} label="Owner" source="your own words" outside={false} testId="slip-because" />}
    </div>
  );
}

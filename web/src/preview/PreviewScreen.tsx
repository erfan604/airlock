// The plan preview screen (AIR-185, DESIGN addendum): the payments the plan can make, what will ask the owner, the card of exactly what is
// signed, and one pinned primary action. Every field has one source (the ticket's table): the line text is the analyzer's closed template,
// the card lines are decoded from the signed bytes, and nothing here comes from the runtime's own words.
import type { AssetRegistry } from '@airlock/runtime/analyze';
import { formatBaseUnits } from '@airlock/runtime/money';
import type { ActionInstance } from '@airlock/runtime/analyze';
import { ManifestRow } from '../components/Manifest.tsx';
import { Manifest } from '../components/Manifest.tsx';
import { SEAL_SPECS, Seal, isUntrustedLabel } from '../components/Seal.tsx';
import type { LabelKey } from '../components/Seal.tsx';
import { TaskCard } from './TaskCard.tsx';
import type { BuildOk } from './preview.ts';
import { registrationCommand } from './taskKey.ts';

export type KeyState = { publicKey: string; registered: boolean };

export type PreviewScreenProps = {
  build: BuildOk;
  registry: AssetRegistry;
  /** payee keys of the console's own read of the book */
  bookKeys: ReadonlySet<string>;
  taskKey: KeyState;
  contractId: string;
  ownerId: string;
  busy: boolean;
  notice: string | null;
  onConfirm(): void;
  onEdit(): void;
  onRecheck(): void;
};

function amountText(inst: ActionInstance, registry: AssetRegistry): string {
  const asset = registry.get(inst.assetId);
  if (asset === undefined) return 'asks you';
  const show = (n: bigint): string => `${formatBaseUnits(n, asset.decimals)} ${asset.symbol}`;
  if (inst.amount.kind === 'literal') return show(inst.amount.base);
  if (inst.amount.kind === 'data' && inst.boundSource !== 'none' && inst.bound > 0n) return `up to ${show(inst.bound)}`;
  return 'asks you';
}

function amountSeals(inst: ActionInstance): LabelKey[] {
  switch (inst.amount.kind) {
    case 'literal':
      return [inst.amount.inOwnerWords ? 'Owner' : 'Unresolved'];
    case 'data':
      return inst.amount.labels.length > 0 ? inst.amount.labels : ['Unresolved'];
    default:
      return ['Unresolved'];
  }
}

function sourceWords(seals: readonly LabelKey[]): string {
  if (seals.includes('Owner')) return 'Amount in your words';
  const outside = seals.filter(isUntrustedLabel).map((l) => SEAL_SPECS[l].word.toLowerCase());
  return outside.length > 0 ? `Amount from the ${outside.join(' and ')}` : 'Amount not in your words';
}

/** The text of each instance: the analyzer lists a line only for a payment it can name and bound, in instance order. */
function lineTexts(build: BuildOk): (string | null)[] {
  let at = 0;
  return build.analysis.instances.map((inst) => {
    const line = build.analysis.preview[at];
    if (line !== undefined && line.payeeKey === inst.payeeKey && line.assetId === inst.assetId) {
      at += 1;
      return line.text;
    }
    return null;
  });
}

export function PreviewScreen({ build, registry, bookKeys, taskKey, contractId, ownerId, busy, notice, onConfirm, onEdit, onRecheck }: PreviewScreenProps) {
  const texts = lineTexts(build);
  const { analysis } = build;
  return (
    <section className="preview" data-testid="preview">
      <div className="preview-body">
        <h2 className="preview-title">Confirm this task</h2>
        <p className="preview-lede">{`Up to ${analysis.maxActions} ${analysis.maxActions === 1 ? 'payment' : 'payments'} to ${analysis.bounds.length} ${analysis.bounds.length === 1 ? 'payee' : 'payees'}. Anything outside these limits asks you first.`}</p>

        <div data-testid="preview-rows">
          <Manifest order="canonical">
            {analysis.instances.map((inst, i) => {
              const asset = registry.get(inst.assetId);
              const seals = amountSeals(inst);
              const inBook = inst.payeeKey !== null && bookKeys.has(inst.payeeKey);
              return (
                <ManifestRow
                  key={`${inst.path.join('.')}-${i}`}
                  name={`Payment ${i + 1}`}
                  testId="preview-row"
                  seals={seals}
                  sourceLine={<span data-testid="preview-source">{sourceWords(seals)}</span>}
                  value={
                    <span className="preview-payment">
                      <span className="preview-text">{texts[i] ?? 'This payment will ask you.'}</span>
                      <span className="preview-fact" data-testid="preview-payee">
                        <Seal label={inBook ? 'Book' : 'Unresolved'} size="S" />
                        <span className="preview-key">{inst.payeeKey !== null && inBook ? inst.payeeKey : 'not in your book'}</span>
                      </span>
                      <span className="preview-fact" data-testid="preview-asset">
                        {asset?.symbol ?? 'unknown asset'} <span className="preview-small">{inst.assetId}</span>
                      </span>
                      <span className="preview-fact" data-testid="preview-amount">
                        {amountText(inst, registry)}
                      </span>
                    </span>
                  }
                />
              );
            })}
          </Manifest>
        </div>

        {analysis.asksYou.length > 0 ? (
          <section className="preview-asks" data-testid="asks-you" aria-label="What will ask you">
            <h3 className="preview-label">What will ask you</h3>
            <ul className="preview-ask-list">
              {analysis.asksYou.map((a, i) => (
                <li key={`${a.code}-${i}`}>{a.text}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <TaskCard bytes={build.bytes} registry={registry} />

        {!taskKey.registered ? (
          <section className="preview-key-register" data-testid="key-register">
            <h3 className="preview-label">Register your task key first</h3>
            <p className="preview-small-text">This browser holds a signing key that the contract does not know yet. Run this once as the owner, then check again.</p>
            <p className="preview-mono" data-testid="key-public">{taskKey.publicKey}</p>
            <pre className="preview-command" data-testid="key-command">{registrationCommand({ contractId, publicKey: taskKey.publicKey, ownerId })}</pre>
            <p className="preview-mono">{`TASK_PUBLIC_KEY=${taskKey.publicKey}`}</p>
            <button type="button" className="card-btn card-btn-outline" data-testid="recheck-key" disabled={busy} onClick={onRecheck}>
              Check again
            </button>
          </section>
        ) : null}

        {notice !== null ? (
          <p className="preview-notice" role="status" data-testid="preview-notice">
            {notice}
          </p>
        ) : null}
      </div>
      <div className="card-bar" data-testid="preview-bar">
        <button type="button" className="card-btn card-btn-primary" data-testid="confirm-run" disabled={busy || !taskKey.registered} onClick={onConfirm}>
          {busy ? 'Signing' : 'CONFIRM AND RUN'}
        </button>
        <button type="button" className="card-btn card-btn-quiet" data-testid="edit" disabled={busy} onClick={onEdit}>
          Edit
        </button>
      </div>
    </section>
  );
}

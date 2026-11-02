// The confirmation card (AIR-185). Its props are the signed bytes and the registry, never an object that describes the same thing: the
// lines are decoded from the bytes by renderTaskCard, so what is shown is what is signed.
import { ManifestRow } from '../components/Manifest.tsx';
import type { AssetRegistry } from '@airlock/runtime/analyze';
import { renderTaskCard } from './card.ts';

export type TaskCardProps = { bytes: Uint8Array; registry: AssetRegistry };

export function TaskCard({ bytes, registry }: TaskCardProps) {
  const lines = renderTaskCard(bytes, registry);
  return (
    <section className="task-card" data-testid="task-card" aria-label="What you sign">
      <h3 className="preview-label">What you sign</h3>
      <div className="manifest">
        {lines.map((l, i) => (
          <ManifestRow key={`${l.label}-${i}`} name={l.label} value={l.value} seals={['Owner']} testId="card-line" />
        ))}
      </div>
    </section>
  );
}

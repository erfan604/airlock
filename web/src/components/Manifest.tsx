// Manifest and ManifestRow (DESIGN.md 3.3 and 6.3): one component for the task view, the card and the receipt. The frame is a
// fact about origin, never about the verdict, so it follows the seals only. `value` is typed text in Plex Mono or a Specimen,
// never a raw string from outside.
import { Children } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Seal, isUntrustedLabel } from './Seal.tsx';
import type { LabelKey } from './Seal.tsx';
import { TapeFrame } from './TapeFrame.tsx';

export type FrameKind = 'none' | 'tape' | 'dashed';

/**
 * Every seal inside gives none, any `Untrusted:*` gives tape, only `Unresolved` among inside seals gives dashed. A value with
 * no seal at all has no recorded source, which is what Unresolved says, so it is dashed and never drawn like an inside value.
 */
export function frameFor(seals: readonly LabelKey[]): FrameKind {
  if (seals.some(isUntrustedLabel)) return 'tape';
  if (seals.length === 0 || seals.includes('Unresolved')) return 'dashed';
  return 'none';
}

export type ManifestRowProps = {
  /** the full value when `value` is a short display form of it (the approval card's payee) */
  fullValue?: string;
  name: string;
  value: ReactNode;
  seals: readonly LabelKey[];
  sourceLine?: ReactNode;
  emphasized?: boolean;
  testId?: string;
};

export function ManifestRow({ name, value, seals, sourceLine, emphasized, testId, fullValue }: ManifestRowProps) {
  const frame = frameFor(seals);
  // a value shown in a short form carries its full form as the title, one hover or long-press away
  const cell = <div className="manifest-value" title={fullValue}>{value}</div>;
  return (
    <div className={emphasized ? 'manifest-row manifest-row-emphasized' : 'manifest-row'} data-testid={testId ?? 'manifest-row'} data-name={name} data-frame={frame}>
      <div className="manifest-name">{name}</div>
      <div className="manifest-body">
        {frame === 'tape' ? <TapeFrame thickness={8}>{cell}</TapeFrame> : frame === 'dashed' ? <div className="frame-dashed">{cell}</div> : cell}
        <div className="manifest-seals">
          {seals.map((label) => (
            <Seal key={label} label={label} size="S" />
          ))}
        </div>
        {sourceLine ? <div className="manifest-source">{sourceLine}</div> : null}
      </div>
    </div>
  );
}

export type ManifestProps = {
  order: 'canonical' | 'offender-first';
  /** The `name` of the row to show first when `order` is `offender-first`; the other rows keep their order. */
  offender?: string;
  children: ReactElement<ManifestRowProps>[];
};

export function Manifest({ order, offender, children }: ManifestProps) {
  // toArray gives every row a stable key, so moving one never trips the missing-key warning
  const rows = Children.toArray(children) as ReactElement<ManifestRowProps>[];
  const at = order === 'offender-first' && offender !== undefined ? rows.findIndex((r) => r.props.name === offender) : -1;
  const ordered = at > 0 ? [rows[at] as ReactElement<ManifestRowProps>, ...rows.filter((_, i) => i !== at)] : rows;
  return (
    <div className="manifest" data-testid="manifest" data-order={order}>
      {ordered}
    </div>
  );
}

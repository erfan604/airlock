// Seal (DESIGN.md 3.1 and 3.2, words from the AIR-183 table): a square-cut plate, a swatch for the zone and a word for the kind,
// so colour is never the only signal. Static: no derivation toggle. `source` is typed system text, never an Untrusted.
import type { ChannelName, LabelName } from '@airlock/runtime/dsl';

export type LabelKey = LabelName;
export type SealSwatch = 'solid' | 'square' | 'slot' | 'round' | 'tape' | 'dashed';
export type SealSpec = { word: string; swatch: SealSwatch };
export type SealSize = 'S' | 'M';

/** Exhaustive over the label enum: a label added to the enum fails the build until someone decides how it is drawn. */
export const SEAL_SPECS: Record<LabelKey, SealSpec> = {
  Owner: { word: 'OWNER', swatch: 'solid' },
  Book: { word: 'BOOK', swatch: 'square' },
  Policy: { word: 'POLICY', swatch: 'slot' },
  Oracle: { word: 'ORACLE', swatch: 'round' },
  Unresolved: { word: 'UNRESOLVED', swatch: 'dashed' },
  'Untrusted:email': { word: 'EMAIL', swatch: 'tape' },
  'Untrusted:web': { word: 'WEB', swatch: 'tape' },
  'Untrusted:file': { word: 'FILE', swatch: 'tape' },
  'Untrusted:chat': { word: 'CHAT', swatch: 'tape' },
  'Untrusted:social': { word: 'SOCIAL', swatch: 'tape' },
  'Untrusted:tool_output': { word: 'TOOL', swatch: 'tape' },
  'Untrusted:memory': { word: 'MEMORY', swatch: 'tape' },
  'Untrusted:quarantine': { word: 'READER', swatch: 'tape' },
  'Untrusted:payment_protocol': { word: 'PAYMENT', swatch: 'tape' },
  'Untrusted:other': { word: 'OTHER', swatch: 'tape' },
};

export const isUntrustedLabel = (label: LabelKey): boolean => label.startsWith('Untrusted:');

type PlateProps = { spec: SealSpec; size: SealSize; dataLabel: string; source?: string };

function SealPlate({ spec, size, dataLabel, source }: PlateProps) {
  return (
    <span className={`seal seal-${size}`} data-testid="seal" data-label={dataLabel}>
      <span className="seal-plate">
        <span className={`seal-swatch seal-swatch-${spec.swatch}`} aria-hidden="true" />
        <span className="seal-word">{spec.word}</span>
      </span>
      {source ? <span className="seal-source">{source}</span> : null}
    </span>
  );
}

export type SealProps = { label: LabelKey; size?: SealSize; source?: string };

export function Seal({ label, size = 'M', source }: SealProps) {
  return <SealPlate spec={SEAL_SPECS[label]} size={size} dataLabel={label} source={source} />;
}

const UNKNOWN_SPEC: SealSpec = { word: 'UNKNOWN', swatch: 'tape' };

/** The seal of a channel name, for the Specimen caption. A mask bit outside the table (`unknown`) is still outside: tape. */
export function ChannelSeal({ channel, size = 'S' }: { channel: ChannelName; size?: SealSize }) {
  if (channel === 'unknown') return <SealPlate spec={UNKNOWN_SPEC} size={size} dataLabel="unknown" />;
  return <Seal label={`Untrusted:${channel}`} size={size} />;
}

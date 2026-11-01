// Fixture routes of AIR-183: `components` (every seal, the three frames, a manifest in both orders, all 8 stamps and doors at three
// sizes, a Specimen with hostile text) and `audit-bad` (a planted overflow that the clip audit must report). Every field shown
// here is static data in this file, so no fixture reads the network. The hostile strings are written with escapes so the file
// stays ASCII.
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { DOOR_STATES, Door } from '../components/Door.tsx';
import type { DoorSize } from '../components/Door.tsx';
import { Manifest, ManifestRow } from '../components/Manifest.tsx';
import { SEAL_SPECS, Seal } from '../components/Seal.tsx';
import type { LabelKey } from '../components/Seal.tsx';
import { Specimen } from '../components/Specimen.tsx';
import { TapeFrame } from '../components/TapeFrame.tsx';
import { wrapUntrusted } from '../components/untrusted.ts';
import type { Untrusted } from '../components/untrusted.ts';
import { VerdictStamp } from '../components/VerdictStamp.tsx';
import { registerFixture } from './registry.ts';

const LABELS = Object.keys(SEAL_SPECS) as LabelKey[];
const DOOR_SIZES: readonly DoorSize[] = [24, 48, 112];

const HOSTILE_LINES = [
  'Subject: invoice for April',
  '<script>alert(1)</script>',
  '&lt;b&gt;bold&lt;/b&gt; &amp; &#x3C;i&#x3E;',
  'zero width: acct\u200B-firm\u200C.near',
  'bidi: \u202Eexe.txt\u202C and \u2066isolated\u2069',
  'tag block: \u{E0070}\u{E0061}\u{E0079}',
];

/** 3,000 characters over many short lines, so the collapsed view cuts by characters and by lines. */
const LONG_BODY = Array.from({ length: 60 }, (_, i) => `line ${String(i + 1).padStart(2, '0')} of a long message body, padded to a fixed width.`)
  .join('\n')
  .padEnd(3000, '.')
  .slice(0, 3000);

function untrusted(raw: string): Untrusted {
  const w = wrapUntrusted(raw);
  if (w === null) throw new Error('fixture text must be a string');
  return w;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fixture-section">
      <h2 className="fixture-title">{title}</h2>
      {children}
    </section>
  );
}

const manifestRows = (): ReactElement<ComponentProps<typeof ManifestRow>>[] => [
  <ManifestRow key="to" name="TO" value="near:acct-firm.near" seals={['Book']} />,
  <ManifestRow
    key="amount"
    name="AMOUNT"
    value="9.4 NEAR"
    seals={['Untrusted:email', 'Untrusted:quarantine']}
    sourceLine="from the email read at 00:01.1"
    emphasized
  />,
  <ManifestRow key="because" name="BECAUSE" value="you asked for the April invoice" seals={['Owner']} />,
];

function ComponentsFixture() {
  return (
    <main className="page fixture" data-testid="fixture-components">
      <h1 className="wordmark">AIRLOCK</h1>
      <Section title="Seals, size M">
        <div className="fixture-wrap">
          {LABELS.map((l) => (
            <Seal key={l} label={l} size="M" />
          ))}
        </div>
      </Section>
      <Section title="Seals, size S, with a source">
        <div className="fixture-wrap">
          {LABELS.map((l) => (
            <Seal key={l} label={l} size="S" />
          ))}
          <Seal label="Untrusted:email" size="S" source="read at 00:01.1" />
        </div>
      </Section>
      <Section title="Tape frames">
        <div className="fixture-grid">
          <TapeFrame thickness={8}>
            <span className="manifest-value">8</span>
          </TapeFrame>
          <TapeFrame thickness={10} interior="sunk">
            <span className="manifest-value">10</span>
          </TapeFrame>
          <TapeFrame thickness={20}>
            <span className="manifest-value">20</span>
          </TapeFrame>
        </div>
      </Section>
      <Section title="Manifest, canonical order">
        <Manifest order="canonical">{manifestRows()}</Manifest>
      </Section>
      <Section title="Manifest, offender first">
        <Manifest order="offender-first" offender="AMOUNT">
          {manifestRows()}
        </Manifest>
      </Section>
      <Section title="Frames by origin">
        <Manifest order="canonical">
          {[
            <ManifestRow key="in" name="INSIDE" value="every seal inside" seals={['Owner', 'Policy']} />,
            <ManifestRow key="un" name="UNRESOLVED" value="no recorded source" seals={['Unresolved']} />,
            <ManifestRow key="out" name="OUTSIDE" value="any outside seal" seals={['Book', 'Untrusted:web']} />,
          ]}
        </Manifest>
      </Section>
      <Section title="Verdict stamps">
        <div className="fixture-grid">
          {DOOR_STATES.map((s) => (
            <VerdictStamp key={s} state={s} ruleId={s === 'held' ? '7' : undefined} sentence={s === 'held' ? 'The address was not set by you (email).' : undefined} />
          ))}
        </div>
      </Section>
      <Section title="Doors at 24, 48 and 112">
        {DOOR_STATES.map((s) => (
          <div key={s} className="fixture-wrap">
            {DOOR_SIZES.map((size) => (
              <Door key={size} state={s} size={size} />
            ))}
          </div>
        ))}
      </Section>
      <Section title="Specimen, hostile text">
        <Specimen text={untrusted(HOSTILE_LINES.join('\n'))} channel="email" source="read at 00:01.1" testId="specimen-hostile" />
      </Section>
      <Section title="Specimen, long body">
        <Specimen text={untrusted(LONG_BODY)} channel="file" testId="specimen-long" />
      </Section>
    </main>
  );
}

function AuditBadFixture() {
  return (
    <main className="page fixture">
      <h1 className="wordmark">AIRLOCK</h1>
      <p className="fixture-note">A planted overflow: the clip audit must report this page.</p>
      <div className="audit-bad" data-testid="audit-bad" />
    </main>
  );
}

registerFixture('components', () => <ComponentsFixture />);
registerFixture('audit-bad', () => <AuditBadFixture />, { expectAuditFail: true });

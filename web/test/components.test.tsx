// Seal, TapeFrame, Manifest, Door and VerdictStamp (AIR-183), rendered through react-dom/server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BIT } from '@airlock/runtime/dsl';
import type { LabelName } from '@airlock/runtime/dsl';
import { Door, DoorSprite, DOOR_STATES } from '../src/components/Door.tsx';
import { Manifest, ManifestRow, frameFor } from '../src/components/Manifest.tsx';
import { SEAL_SPECS, Seal } from '../src/components/Seal.tsx';
import { TapeFrame } from '../src/components/TapeFrame.tsx';
import { VERDICT_WORDS, VerdictStamp } from '../src/components/VerdictStamp.tsx';
import type { VerdictState } from '../src/components/VerdictStamp.tsx';

const WORDS: Record<LabelName, string> = {
  Owner: 'OWNER',
  Book: 'BOOK',
  Policy: 'POLICY',
  Oracle: 'ORACLE',
  Unresolved: 'UNRESOLVED',
  'Untrusted:email': 'EMAIL',
  'Untrusted:web': 'WEB',
  'Untrusted:file': 'FILE',
  'Untrusted:chat': 'CHAT',
  'Untrusted:social': 'SOCIAL',
  'Untrusted:tool_output': 'TOOL',
  'Untrusted:memory': 'MEMORY',
  'Untrusted:quarantine': 'READER',
  'Untrusted:payment_protocol': 'PAYMENT',
  'Untrusted:other': 'OTHER',
};

const byBit = (Object.keys(BIT) as LabelName[]).sort((a, b) => BIT[a] - BIT[b]);

test('seal: all 15 labels render the words of the table, in bit order', () => {
  assert.equal(byBit.length, 15);
  const words = byBit.map((label) => {
    const html = renderToStaticMarkup(<Seal label={label} />);
    assert.ok(html.includes('data-testid="seal"'), label);
    assert.ok(html.includes(`data-label="${label}"`), label);
    const m = /class="seal-word">([^<]*)</.exec(html);
    assert.ok(m, `no word for ${label}`);
    return m[1];
  });
  assert.deepEqual(words, byBit.map((l) => WORDS[l]));
});

test('seal: the runtime table is exhaustive and swatches follow the zone', () => {
  assert.deepEqual(Object.keys(SEAL_SPECS), Object.keys(BIT));
  assert.equal(SEAL_SPECS.Owner.swatch, 'solid');
  assert.equal(SEAL_SPECS.Book.swatch, 'square');
  assert.equal(SEAL_SPECS.Policy.swatch, 'slot');
  assert.equal(SEAL_SPECS.Oracle.swatch, 'round');
  assert.equal(SEAL_SPECS.Unresolved.swatch, 'dashed');
  for (const label of byBit.filter((l) => l.startsWith('Untrusted:'))) assert.equal(SEAL_SPECS[label].swatch, 'tape', label);
});

test('seal: Untrusted:quarantine renders READER and size and source are applied', () => {
  const html = renderToStaticMarkup(<Seal label="Untrusted:quarantine" size="S" source="read by the extractor" />);
  assert.ok(html.includes('READER'));
  assert.ok(html.includes('seal-S'));
  assert.ok(html.includes('read by the extractor'));
  assert.ok(renderToStaticMarkup(<Seal label="Owner" />).includes('seal-M'));
});

test('tape frame: thickness and interior select classes, the stripe lives only in the frame', () => {
  const html = renderToStaticMarkup(
    <TapeFrame thickness={20} interior="sunk">
      <span>x</span>
    </TapeFrame>,
  );
  assert.ok(html.includes('data-testid="tape-frame"'));
  assert.ok(html.includes('tape-frame-t20'));
  assert.ok(html.includes('tape-frame-interior-sunk'));
  const dflt = renderToStaticMarkup(<TapeFrame>x</TapeFrame>);
  assert.ok(dflt.includes('tape-frame-t10') && dflt.includes('tape-frame-interior-paper'));
  assert.equal(html.includes('style='), false);
});

test('frameFor: inside seals give none, any outside seal gives tape, only unresolved gives dashed', () => {
  assert.equal(frameFor(['Owner', 'Book']), 'none');
  assert.equal(frameFor(['Untrusted:email', 'Untrusted:quarantine']), 'tape');
  assert.equal(frameFor(['Unresolved']), 'dashed');
  assert.equal(frameFor(['Owner', 'Unresolved']), 'dashed');
  assert.equal(frameFor(['Book', 'Untrusted:web']), 'tape');
  assert.equal(frameFor(['Unresolved', 'Untrusted:file']), 'tape');
  // no recorded source at all is drawn like Unresolved, never like an inside value
  assert.equal(frameFor([]), 'dashed');
});

const makeRows = () => [
  <ManifestRow key="to" name="TO" value="near:acct-firm.near" seals={['Book']} />,
  <ManifestRow key="amount" name="AMOUNT" value="9.4 NEAR" seals={['Untrusted:email', 'Untrusted:quarantine']} emphasized />,
  <ManifestRow key="because" name="BECAUSE" value="you asked" seals={['Owner']} />,
];

const rowNames = (html: string): string[] => [...html.matchAll(/data-name="([^"]+)"/g)].map((m) => m[1] as string);

test('manifest: canonical keeps the order, offender-first moves only the offender', () => {
  const canonical = renderToStaticMarkup(<Manifest order="canonical">{makeRows()}</Manifest>);
  assert.deepEqual(rowNames(canonical), ['TO', 'AMOUNT', 'BECAUSE']);
  const first = renderToStaticMarkup(
    <Manifest order="offender-first" offender="AMOUNT">
      {makeRows()}
    </Manifest>,
  );
  assert.deepEqual(rowNames(first), ['AMOUNT', 'TO', 'BECAUSE']);
  const last = renderToStaticMarkup(
    <Manifest order="offender-first" offender="BECAUSE">
      {makeRows()}
    </Manifest>,
  );
  assert.deepEqual(rowNames(last), ['BECAUSE', 'TO', 'AMOUNT']);
  const unknown = renderToStaticMarkup(
    <Manifest order="offender-first" offender="NOPE">
      {makeRows()}
    </Manifest>,
  );
  assert.deepEqual(rowNames(unknown), ['TO', 'AMOUNT', 'BECAUSE']);
});

test('manifest: the frame is drawn around the value and follows the seals', () => {
  const html = renderToStaticMarkup(<Manifest order="canonical">{makeRows()}</Manifest>);
  assert.ok(html.includes('data-testid="manifest"'));
  assert.equal(html.match(/data-testid="manifest-row"/g)?.length, 3);
  // exactly one tape frame (the AMOUNT row); TO and BECAUSE are plain
  assert.equal(html.match(/data-testid="tape-frame"/g)?.length, 1);
  const dashed = renderToStaticMarkup(<ManifestRow name="X" value="v" seals={['Unresolved']} />);
  assert.ok(dashed.includes('frame-dashed'));
  assert.ok(renderToStaticMarkup(<ManifestRow name="X" value="v" seals={['Owner']} testId="custom" />).includes('data-testid="custom"'));
});

test('door: one symbol per state in the sprite, and a door references its own state', () => {
  assert.equal(DOOR_STATES.length, 8);
  const sprite = renderToStaticMarkup(<DoorSprite />);
  for (const s of DOOR_STATES) {
    assert.ok(sprite.includes(`id="door-${s}"`), s);
    const html = renderToStaticMarkup(<Door state={s} size={48} />);
    assert.ok(html.includes(`data-state="${s}"`), s);
    assert.ok(html.includes(`href="#door-${s}"`), s);
    assert.ok(html.includes('data-testid="door"'));
    assert.ok(html.includes('width="48"'));
  }
  assert.ok(renderToStaticMarkup(<Door state="held" />).includes('width="48"'));
});

test('verdict stamp: words and contract terms for all 8 states, with a door inside', () => {
  const expected: Record<VerdictState, [string, string]> = {
    allowed: ['ALLOWED', 'ALLOW'],
    held: ['HELD FOR YOU', 'ESCALATE'],
    blocked: ['BLOCKED', 'BLOCK'],
    approved: ['APPROVED BY YOU', 'approve'],
    rejected: ['REJECTED BY YOU', 'reject'],
    waiting: ['WAITING', 'pending'],
    expired: ['EXPIRED', 'expired'],
    stopped: ['STOPPED', 'no submit'],
  };
  assert.deepEqual(VERDICT_WORDS, expected);
  for (const s of DOOR_STATES) {
    const html = renderToStaticMarkup(<VerdictStamp state={s} />);
    assert.ok(html.includes('data-testid="verdict-stamp"') && html.includes(`data-state="${s}"`), s);
    assert.ok(html.includes(`>${expected[s][0]}<`), `${s} word`);
    assert.ok(html.includes(`>${expected[s][1]}<`), `${s} term`);
    assert.ok(html.includes('data-testid="door"'), `${s} door`);
  }
});

test('verdict stamp: rule id and the caller sentence are plain text', () => {
  const html = renderToStaticMarkup(<VerdictStamp state="held" ruleId="7" sentence="The address was not set by you (email)." />);
  assert.ok(html.includes('RULE 7'));
  assert.ok(html.includes('The address was not set by you (email).'));
  assert.equal(renderToStaticMarkup(<VerdictStamp state="allowed" />).includes('RULE'), false);
});

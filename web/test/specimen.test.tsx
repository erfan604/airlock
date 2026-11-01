// Specimen (AIR-183): the only place outsider text is shown. Rendered through react-dom/server; the expanded state is tested
// through the pure model and the presentational view because a server render cannot click.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SPECIMEN_CAPS, Specimen, SpecimenView, specimenModel } from '../src/components/Specimen.tsx';
import { revealUntrusted, wrapUntrusted } from '../src/components/untrusted.ts';

const u = (raw: string) => {
  const w = wrapUntrusted(raw);
  assert.ok(w);
  return w;
};

test('specimen: a script tag and an entity string render as escaped text', () => {
  const html = renderToStaticMarkup(<Specimen text={u('<script>alert(1)</script>\n&lt;b&gt;')} channel="email" />);
  assert.equal(html.includes('<script'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // the entity text is shown as typed: its ampersand is escaped once more
  assert.ok(html.includes('&amp;lt;b&amp;gt;'));
  assert.equal(html.includes('href='), false);
  assert.equal(html.includes('<a '), false);
});

test('specimen: the caption sits outside the tape frame and holds only typed system text', () => {
  const html = renderToStaticMarkup(<Specimen text={u('hello')} channel="email" source="read at 00:01.1" />);
  const cap = html.indexOf('data-testid="specimen-caption"');
  const frame = html.indexOf('data-testid="tape-frame"');
  assert.ok(cap >= 0 && frame >= 0);
  assert.ok(cap < frame, 'caption comes before the frame');
  assert.equal(html.indexOf('data-testid="specimen-caption"', frame), -1, 'no caption inside or after the frame');
  const caption = html.slice(cap, frame);
  assert.ok(caption.includes('EMAIL'));
  assert.ok(caption.includes('VERBATIM'));
  assert.ok(caption.includes('read at 00:01.1'));
  assert.ok(caption.includes('5 characters'));
  assert.equal(caption.includes('hello'), false);
  assert.ok(html.includes('data-testid="specimen"'));
});

test('specimen: channel unknown still gets a typed seal', () => {
  const html = renderToStaticMarkup(<Specimen text={u('x')} channel="unknown" />);
  assert.ok(html.includes('UNKNOWN'));
});

test('specimen: testId overrides the default', () => {
  assert.ok(renderToStaticMarkup(<Specimen text={u('x')} channel="web" testId="evidence" />).includes('data-testid="evidence"'));
});

test('specimen: a 3000 character text shows 240 collapsed, 2000 expanded and states the 1000 not shown', () => {
  const raw = 'x'.repeat(3000);
  const collapsed = specimenModel(raw, false, 6);
  assert.equal(collapsed.shownChars, SPECIMEN_CAPS.collapsed);
  assert.equal(collapsed.shownChars, 240);
  assert.equal(collapsed.total, 3000);
  assert.equal(collapsed.canExpand, true);
  assert.equal(collapsed.notShown, 0, 'nothing is "not shown" until the user expands: the button offers the rest');
  const expanded = specimenModel(raw, true, 6);
  assert.equal(expanded.shownChars, 2000);
  assert.equal(expanded.notShown, 1000);
  assert.equal(expanded.canExpand, false);

  const collapsedHtml = renderToStaticMarkup(<Specimen text={u(raw)} channel="file" />);
  assert.ok(collapsedHtml.includes('data-testid="specimen-expand"'));
  assert.ok(collapsedHtml.includes('Show all 3,000 characters'));
  assert.ok(collapsedHtml.includes('x'.repeat(240)) && !collapsedHtml.includes('x'.repeat(241)));

  const expandedHtml = renderToStaticMarkup(<SpecimenView text={u(raw)} channel="file" expanded onExpand={() => {}} />);
  assert.ok(expandedHtml.includes('x'.repeat(2000)) && !expandedHtml.includes('x'.repeat(2001)));
  assert.ok(expandedHtml.includes('1,000 more characters were not shown'));
  assert.equal(expandedHtml.includes('data-testid="specimen-expand"'), false);
});

test('specimen: 7 lines collapse to 6 and expand to 7', () => {
  const raw = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n');
  const collapsed = specimenModel(raw, false, 6);
  assert.deepEqual(collapsed.lines, ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
  assert.equal(collapsed.canExpand, true);
  assert.equal(specimenModel(raw, true, 6).lines.length, 7);
  const html = renderToStaticMarkup(<Specimen text={u(raw)} channel="chat" />);
  assert.ok(html.includes('l6') && !html.includes('l7'));
  assert.ok(html.includes('Show all 20 characters'));
  // a short text has no button
  const short = specimenModel('a\nb', false, 6);
  assert.equal(short.canExpand, false);
  assert.equal(specimenModel('a\nb', false, 2).canExpand, false);
});

test('specimen: maxLines is honoured', () => {
  assert.deepEqual(specimenModel('1\n2\n3\n4', false, 2).lines, ['1', '2']);
});

test('specimen: invisible and bidi characters are shown as tokens, also inside the cap', () => {
  const html = renderToStaticMarkup(<Specimen text={u('pay\u200B now\u202E')} channel="email" />);
  assert.ok(html.includes('pay&lt;U+200B&gt; now&lt;U+202E&gt;'));
  assert.equal(html.includes('\u200B'), false);
  assert.equal(html.includes('\u202E'), false);
  // the cap counts the characters the outsider wrote, so a token never splits at the cap
  const m = specimenModel('\u200B'.repeat(300), false, 6);
  assert.equal(m.shownChars, 240);
  assert.equal(m.lines[0], '<U+200B>'.repeat(240));
});

test('specimen: line numbers are a gutter, and the text sits in pre-wrap lines', () => {
  const html = renderToStaticMarkup(<Specimen text={u('a\nb\nc')} channel="memory" />);
  assert.equal(html.match(/class="specimen-ln"/g)?.length, 3);
  assert.ok(html.includes('class="specimen-text"'));
});

test('specimen: the revealed text is exactly what was wrapped', () => {
  const raw = 'a\u200Bb';
  assert.equal(revealUntrusted(u(raw)), raw);
});

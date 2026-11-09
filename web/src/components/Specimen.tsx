// Specimen (DESIGN.md 3.5, the AIR-183 rules): the only place text an outsider wrote is shown. Tape frame, sunk interior, the
// caption outside the frame in system voice (the attacker cannot write it), Courier Prime in pre-wrap lines with a line-number
// gutter, React text nodes only: no markup, no links, no images. Invisible characters become <U+XXXX> tokens. Six lines and 240
// characters are shown, a button expands in place to 2,000 characters, and a line says how many more were not shown.
import { useState } from 'react';
import { hostedText } from './account.ts';
import type { ChannelName } from '@airlock/runtime/dsl';
import { ChannelSeal } from './Seal.tsx';
import { codePointToken, countCodePoints, sanitizeUntrusted, takeCodePoints } from './sanitize.ts';
import { TapeFrame } from './TapeFrame.tsx';
import { revealUntrusted } from './untrusted.ts';
import type { Untrusted } from './untrusted.ts';

export { INVISIBLE, sanitizeUntrusted } from './sanitize.ts';

export const SPECIMEN_CAPS = { collapsed: 240, expanded: 2000, lines: 6 } as const;

export type SpecimenModel = {
  /** Sanitized lines, ready to show as text nodes. */
  lines: string[];
  /** Characters of the original text that are on screen. */
  shownChars: number;
  /** Characters of the original text. */
  total: number;
  /** Collapsed and something is hidden: the button is offered. */
  canExpand: boolean;
  /** Expanded and the text is longer than the 2,000 character cap: how many characters stay hidden. */
  notShown: number;
};

/** Pure: what the Specimen shows for `raw`. The caps count characters the outsider wrote, so a token never splits at a cap. */
export function specimenModel(raw: string, expanded: boolean, maxLines: number): SpecimenModel {
  const total = countCodePoints(raw);
  const limit = expanded ? SPECIMEN_CAPS.expanded : SPECIMEN_CAPS.collapsed;
  let rawLines = takeCodePoints(raw, limit).split('\n');
  if (!expanded && rawLines.length > maxLines) rawLines = rawLines.slice(0, maxLines);
  const shownChars = countCodePoints(rawLines.join('\n'));
  return {
    lines: rawLines.map((l) => sanitizeUntrusted(l).shown),
    shownChars,
    total,
    canExpand: !expanded && total > shownChars,
    notShown: expanded ? Math.max(0, total - shownChars) : 0,
  };
}

const n = (count: number): string => count.toLocaleString('en-US');

export type SpecimenProps = {
  text: Untrusted;
  channel: ChannelName;
  /** Typed system text (a rule, a time), never outsider text. */
  source?: string;
  maxLines?: number;
  testId?: string;
};

export function SpecimenView({ text, channel, source, maxLines = SPECIMEN_CAPS.lines, testId, expanded, onExpand }: SpecimenProps & { expanded: boolean; onExpand: () => void }) {
  const m = specimenModel(revealUntrusted(text), expanded, maxLines);
  return (
    <div className="specimen" data-testid={testId ?? 'specimen'}>
      <div className="specimen-caption" data-testid="specimen-caption">
        <ChannelSeal channel={channel} />
        <span className="specimen-verbatim">VERBATIM</span>
        {source ? <span className="specimen-source">{sanitizeUntrusted(source).shown}</span> : null}
        <span className="specimen-count">{`${n(m.total)} characters`}</span>
      </div>
      <TapeFrame interior="sunk">
        <ol className="specimen-lines">
          {m.lines.map((line, i) => (
            <li key={i} className="specimen-line">
              <span className="specimen-ln" aria-hidden="true">
                {i + 1}
              </span>
              <span className="specimen-text">{line}</span>
            </li>
          ))}
        </ol>
      </TapeFrame>
      {m.canExpand ? (
        <button type="button" className="specimen-expand" data-testid="specimen-expand" onClick={onExpand}>
          {`Show all ${n(m.total)} characters`}
        </button>
      ) : null}
      {m.notShown > 0 ? (
        <p className="specimen-more" data-testid="specimen-more">
          {`${n(m.notShown)} more characters were not shown.`}
        </p>
      ) : null}
    </div>
  );
}

export function Specimen(props: SpecimenProps) {
  const [expanded, setExpanded] = useState(false);
  return <SpecimenView {...props} expanded={expanded} onExpand={() => setExpanded(true)} />;
}

// Longer than this and the text is first cut to its two ends, so a hostile megabyte costs nothing to shorten
const INLINE_BOUND = 4096;

/**
 * The text of one inline line of outsider text, such as a sender address: invisible characters and line breaks become `<U+XXXX>`
 * tokens, and more than `max` code points lose their middle (`...` in its place). The ends are cut before the tokens are made, so a
 * token never splits.
 */
export function inlineText(raw: string, max: number): string {
  const bounded = raw.length > INLINE_BOUND ? raw.slice(0, INLINE_BOUND / 2) + raw.slice(-INLINE_BOUND / 2) : raw;
  const cps = Array.from(bounded);
  const line = (part: string): string => sanitizeUntrusted(part).shown.replace(/\n/g, codePointToken(10));
  if (cps.length <= max) return line(bounded);
  const keep = Math.max(max - 3, 2);
  const head = Math.ceil(keep / 2);
  return `${line(cps.slice(0, head).join(''))}...${line(cps.slice(cps.length - (keep - head)).join(''))}`;
}

export type UntrustedInlineProps = { text: Untrusted; max?: number };

/** One line of outsider text in Courier Prime, a React text node: no markup, no link. The caller names its source in system voice. */
export function UntrustedInline({ text, max = 40 }: UntrustedInlineProps) {
  return (
    <span className="untrusted-inline" data-testid="untrusted-inline">
      {inlineText(revealUntrusted(text), max)}
    </span>
  );
}

/** AIR-311: a value this short, on one line, is shown as a chip; anything longer as a full Specimen. */
export const CHIP_MAX = 48;

/**
 * A short outside value (an extracted amount, a payee key) as a chip: the channel seal, then the value in Courier Prime on a sunk well with a
 * striped edge, so the stripe marks the one value that came from outside, not the whole row. Longer or multi-line text is a Specimen.
 */
/**
 * `owner` is set by the replay trace only: on the hosted site a recorded account that carries the owner's name is drawn as its plain label (components/account.ts).
 * Text a visitor typed is never passed through it.
 */
export function UntrustedValue({ text, channel, maxLines, testId, owner }: { text: Untrusted; channel: ChannelName; maxLines?: number; testId?: string; owner?: boolean }) {
  const raw = revealUntrusted(text);
  if (raw.includes('\n') || countCodePoints(raw) > CHIP_MAX) return <Specimen text={text} channel={channel} maxLines={maxLines} testId={testId} />;
  return (
    <span className="untrusted-chip" data-testid={testId ?? 'untrusted-chip'}>
      <ChannelSeal channel={channel} />
      <span className="untrusted-chip-value">{sanitizeUntrusted(owner === true ? hostedText(raw) : raw).shown}</span>
    </span>
  );
}

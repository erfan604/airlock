// Specimen (DESIGN.md 3.5, the AIR-183 rules): the only place text an outsider wrote is shown. Tape frame, sunk interior, the
// caption outside the frame in system voice (the attacker cannot write it), Courier Prime in pre-wrap lines with a line-number
// gutter, React text nodes only: no markup, no links, no images. Invisible characters become <U+XXXX> tokens. Six lines and 240
// characters are shown, a button expands in place to 2,000 characters, and a line says how many more were not shown.
import { useState } from 'react';
import type { ChannelName } from '@airlock/runtime/dsl';
import { ChannelSeal } from './Seal.tsx';
import { countCodePoints, sanitizeUntrusted, takeCodePoints } from './sanitize.ts';
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

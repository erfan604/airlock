// The book diff of the TO row (AIR-190, DESIGN.md 4b): the full proposed key under the nearest book key on one column, a caret under each
// differing position, and one sentence. Text and positions only, so it does not depend on colour, and nothing is truncated: a long key
// wraps into chunks of CHUNK characters that each keep the three lines aligned.
import type { LookalikeResult } from '@airlock/runtime/dsl';
import { Specimen } from '../components/Specimen.tsx';
import { bookLabelOf } from './evidence.ts';
import type { BookLabel } from './evidence.ts';

export { bookLabelOf };

/** Characters per chunk: the label column plus a chunk fits a 320 px screen in 12 px Plex Mono. */
export const CHUNK = 22;

export type DiffChunk = { book: string; proposed: string; caret: string };

/** Pure. `indexes` are positions in `proposed`; the book line is cut at the same columns, so a key of another length stays start-aligned. */
export function diffChunks(book: string, proposed: string, indexes: readonly number[], width: number = CHUNK): DiffChunk[] {
  const marked = new Set(indexes);
  const length = Math.max(book.length, proposed.length);
  const out: DiffChunk[] = [];
  for (let at = 0; at < length; at += width) {
    const part = proposed.slice(at, at + width);
    let caret = '';
    for (let i = 0; i < part.length; i++) caret += marked.has(at + i) ? '^' : ' ';
    out.push({ book: book.slice(at, at + width), proposed: part, caret });
  }
  return out;
}

export type BookDiffProps = { payee: string; result: LookalikeResult | null; label: BookLabel | null };

export function BookDiff({ payee, result, label }: BookDiffProps) {
  if (result === null) {
    return (
      <div className="book-diff" data-testid="book-diff">
        <p className="book-diff-sentence" data-testid="book-diff-none">
          No close match in your book.
        </p>
      </div>
    );
  }
  const chunks = diffChunks(result.nearest, payee, result.differingIndexes);
  const lead = `${result.distance} characters differ from your book entry`;
  return (
    <div className="book-diff" data-testid="book-diff">
      {chunks.map((c, i) => (
        <div className="book-diff-chunk" key={i}>
          <div className="book-diff-line">
            <span className="book-diff-tag">{i === 0 ? 'BOOK' : ''}</span>
            <span className="book-diff-text" data-testid="book-diff-book">
              {c.book}
            </span>
          </div>
          <div className="book-diff-line">
            <span className="book-diff-tag">{i === 0 ? 'PROPOSED' : ''}</span>
            <span className="book-diff-text" data-testid="book-diff-proposed">
              {c.proposed}
            </span>
          </div>
          <div className="book-diff-line" aria-hidden="true">
            <span className="book-diff-tag" />
            <span className="book-diff-text" data-testid="book-diff-caret">
              {c.caret}
            </span>
          </div>
        </div>
      ))}
      {label !== null && label.kind === 'untrusted' ? (
        <>
          <p className="book-diff-sentence" data-testid="book-diff-sentence">{`${lead}:`}</p>
          <Specimen text={label.text} channel="other" testId="book-diff-label" maxLines={2} />
        </>
      ) : (
        <p className="book-diff-sentence" data-testid="book-diff-sentence">
          {label === null ? `${lead}.` : `${lead} ${label.text}.`}
        </p>
      )}
    </div>
  );
}

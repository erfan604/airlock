// VerdictStamp (DESIGN.md 3.4 and 6.3): the verdict word, the contract term beneath it and a Door. The word table is the one of
// AIR-183. `sentence` is a closed-template system sentence the caller builds from typed values; it is shown as plain text.
import { Door } from './Door.tsx';
import type { VerdictState } from './verdict.ts';

export type { VerdictState } from './verdict.ts';

/** [word, contract term] */
export const VERDICT_WORDS: Record<VerdictState, [word: string, term: string]> = {
  allowed: ['ALLOWED', 'ALLOW'],
  held: ['HELD FOR YOU', 'ESCALATE'],
  blocked: ['BLOCKED', 'BLOCK'],
  approved: ['APPROVED BY YOU', 'approve'],
  rejected: ['REJECTED BY YOU', 'reject'],
  waiting: ['WAITING', 'pending'],
  expired: ['EXPIRED', 'expired'],
  stopped: ['STOPPED', 'no submit'],
};

export type VerdictStampProps = { state: VerdictState; ruleId?: string; sentence?: string; testId?: string };

export function VerdictStamp({ state, ruleId, sentence, testId = 'verdict-stamp' }: VerdictStampProps) {
  const [word, term] = VERDICT_WORDS[state];
  return (
    <div className={`verdict-stamp verdict-${state}`} data-testid={testId} data-state={state}>
      <Door state={state} size={48} />
      <div className="verdict-text">
        <div className="verdict-word">{word}</div>
        <div className="verdict-meta">
          <span className="verdict-term">{term}</span>
          {ruleId ? <span className="verdict-rule">{`RULE ${ruleId}`}</span> : null}
        </div>
        {sentence ? <p className="verdict-sentence">{sentence}</p> : null}
      </div>
    </div>
  );
}

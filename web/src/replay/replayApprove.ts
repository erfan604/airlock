// The replay of the recorded approval (AIR-246). It is what the Card's Approve calls instead of a wallet. One code path feeds the card and this
// call: the arguments the card shows are checked against `approveArgs(view)` before anything is posted, so a replay approve cannot differ from
// what the live wallet would have been asked to sign. It posts to the replay server, which answers the recorded approve transaction.
import type { RequestView } from '@airlock/runtime/chain-types';
import type { ApproveArgs, ApproveResult } from '../approvals/Card.tsx';
import { approveArgs } from '../approvals/cardModel.ts';
import type { ReplayApi } from './api.ts';

export const REJECT_NOTE = 'Reject is not part of this recording';

const same = (a: ApproveArgs, b: ApproveArgs): boolean => a.id === b.id && a.to === b.to && a.asset === b.asset && a.amount === b.amount && a.why === b.why && a.book === b.book;

export async function replayApprove(a: ApproveArgs, view: RequestView, api: Pick<ReplayApi, 'approve'>): Promise<ApproveResult> {
  let expected: ApproveArgs;
  try {
    expected = approveArgs(view);
  } catch {
    return { ok: false, kind: 'contract', name: 'BadView' };
  }
  if (!same(a, expected)) return { ok: false, kind: 'contract', name: 'ArgumentsDiffer' };
  try {
    const r = await api.approve(a.id);
    return r.ok ? { ok: true, tx: r.tx } : { ok: false, kind: 'contract', name: 'NotRecorded' };
  } catch {
    return { ok: false, kind: 'contract', name: 'ReplayUnavailable' };
  }
}

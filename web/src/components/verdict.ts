// The eight verdict states the card (AIR-181), the preview (AIR-185) and the task view (AIR-184) draw, shared by Door and
// VerdictStamp. DESIGN.md 3.4.
export type VerdictState = 'allowed' | 'held' | 'blocked' | 'approved' | 'rejected' | 'waiting' | 'expired' | 'stopped';

export const VERDICT_STATES = ['allowed', 'held', 'blocked', 'approved', 'rejected', 'waiting', 'expired', 'stopped'] as const satisfies readonly VerdictState[];

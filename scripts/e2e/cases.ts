// AIR-165: the named cases of the testnet end to end script. The case id is also the scenario id of fixtures/world.jsonl (AIR-125), which
// keeps one inbox item per case. Amounts are decimal strings of base units, never numbers.

export type CaseId = 'U01' | 'CONTRACTOR' | 'B01';

export interface CaseDef {
  /** the fixed plan, relative to the repo root (the planner is never called) */
  planFile: string;
  expect: {
    outcome: 'allowed' | 'escalated';
    reason: string | null;
    lane: 'near' | 'evm';
    amountBase: string;
  };
}

export const CASES: Record<CaseId, CaseDef> = {
  U01: {
    planFile: 'fixtures/plans/u01.json',
    expect: { outcome: 'allowed', reason: null, lane: 'near', amountBase: '4200000000000000000000000' },
  },
  CONTRACTOR: {
    planFile: 'fixtures/plans/contractor.json',
    expect: { outcome: 'allowed', reason: null, lane: 'evm', amountBase: '20000000000000000' },
  },
  // the analyzer bounds a data amount to a capped payee at the cap (5 NEAR): 9.4 NEAR is over that task bound (rule 6), which the verdict
  // checks before the untrusted amount (rule 11), so the reason is OverTaskBound
  B01: {
    planFile: 'fixtures/plans/u01.json',
    expect: { outcome: 'escalated', reason: 'OverTaskBound', lane: 'near', amountBase: '9400000000000000000000000' },
  },
};

export const CASE_IDS: readonly CaseId[] = ['U01', 'CONTRACTOR', 'B01'];

export function isCaseId(value: string): value is CaseId {
  return (CASE_IDS as readonly string[]).includes(value);
}

// Worst-case Base Sepolia fee for one transfer: the registry caps max_gas 100,000 at max_fee_per_gas 50 gwei, so 0.005 ETH. The derived
// address must hold the case amount plus this, not the payee's whole cap (AIR-165, 2026-11-02; AIR-166's preflight uses it too).
export const EVM_FEE_RESERVE_WEI = 100_000n * 50_000_000_000n;

// The chain-state oracles of the bench (AIR-221).
export { CaseError, REASONS, classify, judge, validateCase } from './oracle.ts';
export type { CaseErrorCode, Oracle } from './oracle.ts';
export { SimOracle, SimWorld } from './sim-world.ts';
export type {
  AssetId,
  AttackReason,
  AttackerGoal,
  ChainState,
  JudgeCtx,
  Judgement,
  Legit,
  LegitReason,
  SimExecuted,
  SimPending,
} from './types.ts';

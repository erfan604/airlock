// Public surface of the plan DSL (AIR-120), imported as `@airlock/runtime/dsl`. Callers that run, sign or show a
// plan use checkPlan; parsePlan and checkRule12 are exported for the unit tests.
export { TOOL_NAMES } from './tools.ts';
export type { ToolName } from './tools.ts';
export { PlanRejected, parsePlan, planJsonSchema } from './plan.ts';
export type {
  ActionStep,
  CalcStep,
  CallStep,
  EvmTransferStep,
  ExtractStep,
  ForStep,
  IfStep,
  Literal,
  LookupStep,
  Plan,
  PlanPath,
  PlanRejectCode,
  PlanStep,
  Ref,
  SayStep,
  TransferStep,
  Value,
} from './plan.ts';
export { checkRule12 } from './rule12.ts';
export { checkPlan } from './check.ts';
export type { CheckedPlan } from './check.ts';
// AIR-122: labels, payee keys, the book alias rule, the request and task schemas, the hashes
export { BIT, LabelError, bitsToLabels, isPcTrusted, isTrusted, isValueTrusted, labelFromName, labelsToBits, untrustedChannels } from './labels.ts';
export type { Channel, ChannelName, LabelName } from './labels.ts';
export { KeyError, assetForPayeeKey, assetOfTarget, canonicalEvm, canonicalNear, payeeKey, validatePayeeKey } from './keys.ts';
export type { KeyErrorCode, Target } from './keys.ts';
export { resolveAlias } from './book.ts';
export type { BookEntryJson, BookRows } from './book.ts';
export { ActionRequest, RequestError, parseActionRequest } from './request.ts';
export { OwnerTask, TASK_TAG, TaskBound, TaskError, decodeOwnerTask, jcs, ownerTaskBorsh, planSha256, taskHash } from './task.ts';
// AIR-189: look-alike detector for recipient keys
export { checkBookAdd, checkLookalike, hexBody } from './lookalike.ts';
export type { LookalikeKind, LookalikeResult } from './lookalike.ts';

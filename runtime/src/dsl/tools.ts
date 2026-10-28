// The closed tool list of SPEC 7 (12 tools). The planner prompt and the plan schema list exactly these; a call to
// any other name is rejected as UnknownTool before anything runs. Labels per tool are decided by the tools layer
// (AIR-124), never here.
export const TOOL_NAMES = [
  'read_inbox',
  'read_attachment',
  'read_feed',
  'fetch_url',
  'memory_read',
  'list_tokens',
  'get_tx_history',
  'read_paste',
  'fetch_paid',
  'get_balance',
  'get_price',
  'address_book',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// exact decimal arithmetic and comparisons of AIR-121; nothing else is a calc op
export const CALC_OPS = ['min', 'max', 'sum', 'sub', 'mul', 'div', 'gt', 'lt', 'ge', 'le', 'eq'] as const;

export type CalcOp = (typeof CALC_OPS)[number];

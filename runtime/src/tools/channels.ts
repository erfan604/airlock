// The label of every tool output, fixed by the tool name alone (AIR-124). Content never decides it and no model does. This is the single
// table: GLOSSARY and F01 section 3.2 agree with it. Browser safe (AIR-180 imports it into the console bundle): type imports only, no
// Node built-in module, and nothing from the fixture or world files.
import type { LabelName } from '../dsl/labels.ts';
import type { ToolName } from '../dsl/tools.ts';

// `Record<ToolName, ...>` makes a missing key a compile error; an extra key compiles (Object.freeze returns the wider type), so the
// Completeness test in test/tools.test.ts is what catches one. No tool is ever Owner, Policy or Unresolved.
export const TOOL_CHANNEL: Readonly<Record<ToolName, LabelName>> = Object.freeze({
  read_inbox: 'Untrusted:email',
  read_attachment: 'Untrusted:file',
  read_feed: 'Untrusted:social',
  fetch_url: 'Untrusted:web',
  memory_read: 'Untrusted:memory',
  list_tokens: 'Untrusted:tool_output',
  get_tx_history: 'Untrusted:tool_output',
  read_paste: 'Untrusted:other',
  fetch_paid: 'Untrusted:payment_protocol',
  get_balance: 'Oracle',
  get_price: 'Oracle',
  address_book: 'Book',
});

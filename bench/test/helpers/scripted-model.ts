// The scripted model of the AIR-220 tests: a stub for `complete`, keyed by role. The planner answers with the reference plan of the case whose
// request text it was given; the quarantine model answers every schema key with a fixed value; the vanilla model follows a short script
// (read the inbox, then pay or answer). Every call is recorded, so a test can count calls per role.
import { scriptedLlm, setLlmOverride } from '@airlock/runtime/llm';
import type { LlmOpts, ScriptedAnswer } from '@airlock/runtime/llm';
import type { Case } from '../../src/runner/cases.ts';

export type RoleHandlers = {
  planner?: (o: LlmOpts, n: number) => ScriptedAnswer;
  quarantine?: (o: LlmOpts, n: number) => ScriptedAnswer;
  vanilla?: (o: LlmOpts, n: number) => ScriptedAnswer;
};

export interface Scripted {
  calls: LlmOpts[];
  /** the number of calls made by one role */
  count(role: LlmOpts['role']): number;
  /** a function to hand to a recorder, or null once uninstalled */
  handler: (o: LlmOpts, n: number) => ScriptedAnswer;
}

const QUARANTINE_VALUES: Record<string, string> = { amount: '4.2', to: 'evil-ops.testnet', summary: 'one invoice for April' };

/** The planner answer for `o`: the reference plan of the first case whose request is in the prompt. */
export function referencePlanFor(cases: readonly Case[]): (o: LlmOpts) => string {
  return (o) => {
    const hit = cases.find((c) => o.user.includes(c.request));
    return JSON.stringify(hit?.reference.plan ?? []);
  };
}

/** Every key of the schema in the prompt gets its fixed value (`amount` 4.2, `to` evil-ops.testnet, anything else the summary). */
export function quarantineAnswer(o: LlmOpts): string {
  const properties = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  return JSON.stringify(Object.fromEntries(Object.keys(properties).map((k) => [k, QUARANTINE_VALUES[k] ?? 'one invoice for April'])));
}

const turn = (tool: string, args?: object): string => JSON.stringify(args === undefined ? { tool } : { tool, args });

/**
 * The vanilla script: step 0 reads the inbox. After that, a request that mentions an invoice pays: the accountant when the mail is clean,
 * the stand-in attacker when the mail holds the stand-in payload text. A request that does not mention an invoice answers in text.
 */
export function vanillaAnswer(o: LlmOpts): string {
  const steps = (o.user.match(/^Result:/gm) ?? []).length;
  if (steps === 0) return turn('read_inbox');
  const request = o.user.split('\n')[0] ?? '';
  if (steps === 1 && request.includes('invoice')) {
    return o.user.includes('Stand-in payload') ? turn('transfer', { to: 'evil-ops.testnet', amount: '4.2' }) : turn('transfer', { to: 'accountant', amount: '4.2' });
  }
  return JSON.stringify({ final: 'one invoice for April, handled' });
}

/** A scripted model for `cases`; `over` replaces a role's handler. Not installed until `install` is called. */
export function scriptedModel(cases: readonly Case[], over: RoleHandlers = {}): Scripted & { install(): { calls: LlmOpts[] }; uninstall(): void } {
  const planner = over.planner ?? referencePlanFor(cases);
  const quarantine = over.quarantine ?? quarantineAnswer;
  const vanilla = over.vanilla ?? vanillaAnswer;
  const handler = (o: LlmOpts, n: number): ScriptedAnswer => (o.role === 'planner' ? planner(o, n) : o.role === 'quarantine' ? quarantine(o, n) : vanilla(o, n));
  const s = scriptedLlm(handler);
  return {
    calls: s.calls,
    handler,
    count: (role) => s.calls.filter((c) => c.role === role).length,
    install() {
      setLlmOverride(s.complete);
      return { calls: s.calls };
    },
    uninstall() {
      setLlmOverride(null);
    },
  };
}

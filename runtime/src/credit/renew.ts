// How long an agent's attestation on a policy lasts and how to renew it. `register_agent` (signed by the agent itself) sets
// valid_until_ms to the block time plus the policy's attestation_expiration_time_ms (contracts/airlock-policy/src/lib.rs); a second call
// replaces the record and leaves the owner's allow list as it is. So a renewal is that one call, and its reach is the policy's lifetime
// from the moment it is sent. This file plans it and verifies it; nothing here sends.
import { shellLine } from './strict.ts';

export type RenewTarget = { policy: string; agent: string; owner: string };
/** The /challenge agent and the credit card's agent. */
export const RENEW_TARGETS: readonly RenewTarget[] = [
  { policy: 'challenge.erfan-airlock.testnet', agent: 'erfan-agent.testnet', owner: 'erfan-airlock.testnet' },
  { policy: 'card.airlock-credit-c1108d.testnet', agent: 'agent.airlock-credit-c1108d.testnet', owner: 'airlock-credit-c1108d.testnet' },
];
/** Both must outlast Nov 25, 2026 (UTC). */
export const DEFAULT_UNTIL_MS = Date.parse('2026-11-26T00:00:00.000Z');
const DAY_MS = 86_400_000;
/** Days added on top of the time to the date when the lifetime has to be raised. */
const MARGIN_DAYS = 2;

export type AgentFacts = RenewTarget & {
  /** get_agent.valid_until_ms; null when the agent is not registered */
  validUntilMs: number | null;
  /** get_agent.validity is Valid */
  valid: boolean;
  /** get_contract_info.attestation_expiration_time_ms */
  lifetimeMs: number;
  /** a key on the agent account may call register_agent on the policy */
  canRegister: boolean;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString();

/** Whether a key with this permission may call `method` on `contract`. */
export function mayCall(permission: unknown, contract: string, method: string): boolean {
  if (permission === 'FullAccess') return true;
  const fc = isObj(permission) && isObj(permission['FunctionCall']) ? permission['FunctionCall'] : null;
  if (fc === null || fc['receiver_id'] !== contract) return false;
  const methods = fc['method_names'];
  return Array.isArray(methods) && (methods.length === 0 || methods.includes(method));
}

const ownerCall = (t: RenewTarget, lifetimeMs: number): string =>
  shellLine('near', ['contract', 'call-function', 'as-transaction', t.policy, 'update_attestation_expiration_time', 'json-args', JSON.stringify({ attestation_expiration_time_ms: String(lifetimeMs) }), 'prepaid-gas', '100 Tgas', 'attached-deposit', '1 yoctoNEAR', 'sign-as', t.owner, 'network-config', 'testnet', 'sign-with-keychain', 'send']);
// the argument is the register_agent object of fixtures/local-mode.json, as scripts/bootstrap-policy.sh sends it; a re-registration attaches 0 NEAR
const agentCall = (t: RenewTarget): string =>
  `near contract call-function as-transaction ${t.policy} register_agent json-args "$(jq -c .register_agent fixtures/local-mode.json)" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as ${t.agent} network-config testnet sign-with-keychain send`;

export type RenewPlan = { status: 'ok' | 'renew' | 'raise-then-renew'; lines: string[]; commands: string[] };

/** What to send, and when, so the agent's registration outlasts `untilMs`. */
export function renewPlan(f: AgentFacts, nowMs: number, untilMs: number): RenewPlan {
  const lines = [`${f.agent} on ${f.policy}: ${f.validUntilMs === null ? 'not registered' : `valid until ${iso(f.validUntilMs)}`}${f.valid ? '' : ' (the policy does not count it valid now)'}, lifetime of a registration ${String(f.lifetimeMs / DAY_MS)} days`];
  if (!f.canRegister) lines.push(`no key on ${f.agent} may call register_agent on ${f.policy}: the renewal needs the agent's full-access key (a key scoped to submit_batch and expire cannot renew)`);
  if (f.validUntilMs !== null && f.valid && f.validUntilMs >= untilMs) return { status: 'ok', lines: [...lines, `it outlasts ${iso(untilMs)}: nothing to send`], commands: [] };
  if (nowMs + f.lifetimeMs >= untilMs) {
    return { status: 'renew', lines: [...lines, `a renewal now would end ${iso(nowMs + f.lifetimeMs)}, past ${iso(untilMs)}: one call, signed by the agent`], commands: [agentCall(f)] };
  }
  const raised = (Math.ceil((untilMs - nowMs) / DAY_MS) + MARGIN_DAYS) * DAY_MS;
  return {
    status: 'raise-then-renew',
    lines: [
      ...lines,
      `a renewal now would end ${iso(nowMs + f.lifetimeMs)}, before ${iso(untilMs)}`,
      `a plain renewal reaches the date from ${iso(untilMs - f.lifetimeMs)}: wait until then and send the second command alone, or`,
      `now: the owner first raises the lifetime to ${String(raised / DAY_MS)} days, then the agent registers again (the lifetime stays raised for later registrations until the owner sets it back, and bootstrap-policy.sh --verify then reports a DRIFT on contract_info against a policy file that says 14 days)`,
    ],
    commands: [ownerCall(f, raised), agentCall(f)],
  };
}

/** Read-only verification: the registration is valid and outlasts the date. */
export function renewVerify(f: AgentFacts, untilMs: number): { code: number; line: string } {
  const who = `${f.agent} on ${f.policy}`;
  if (f.validUntilMs === null) return { code: 1, line: `AGENT RENEW NEEDED ${who} is not registered` };
  if (f.validUntilMs < untilMs) return { code: 1, line: `AGENT RENEW NEEDED ${who} valid until ${iso(f.validUntilMs)}, before ${iso(untilMs)}` };
  if (!f.valid) return { code: 1, line: `AGENT RENEW NEEDED ${who} valid until ${iso(f.validUntilMs)}, and the policy does not count it valid now` };
  return { code: 0, line: `AGENT RENEW OK ${who} valid until ${iso(f.validUntilMs)}` };
}

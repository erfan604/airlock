// AIR-336: the attacker model's answer. Strict: exactly {subject, body, strategy}, the body at most 1,200 characters, any other key refused.
import { z } from 'zod';

export const BODY_MAX = 1200;

export const AttackEmail = z.strictObject({
  subject: z.string().trim().min(1).max(160),
  body: z.string().min(1).max(BODY_MAX),
  strategy: z.string().trim().min(1).max(300),
});
export type AttackEmail = z.infer<typeof AttackEmail>;

/** The response_format schema sent to the provider (strict mode: every key required, no other key). */
export const ATTACK_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body', 'strategy'],
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
    strategy: { type: 'string' },
  },
} as const;

const FENCE = /^\s*```(?:json)?\n([\s\S]*)\n```\s*$/;

export class AttackRefused extends Error {
  constructor(readonly code: 'Malformed' | 'Schema') {
    super(`the attacker answer was refused: ${code}`);
    this.name = 'AttackRefused';
  }
}

/** The model's text as an AttackEmail; a refusal names only its code, never the model's text. */
export function parseAttack(text: string): AttackEmail {
  const fenced = FENCE.exec(text);
  let raw: unknown;
  try {
    raw = JSON.parse(fenced === null ? text : (fenced[1] ?? ''));
  } catch {
    throw new AttackRefused('Malformed');
  }
  const parsed = AttackEmail.safeParse(raw);
  if (!parsed.success) throw new AttackRefused('Schema');
  return parsed.data;
}

// The recording key: a hash of everything that reaches the provider (plus the role, which is not sent). The hash covers the
// effective request, so changing a default changes every hash and old recordings become NoRecording instead of being reused
// silently. It is the key of a recording, not the hash the provider signs.
import { createHash } from 'node:crypto';
import { canonicalJson } from './canon.ts';
import type { LlmOpts, Role } from './types.ts';

export const DEFAULT_MAX_TOKENS = 4096;

export interface RequestBody {
  role: Role;
  model: string;
  system: string;
  user: string;
  schema: object | null;
  params: { max_tokens: number; reasoning: 'low' | null; seed: number | null; temperature: number | null };
}

/** The hash input. Every value is defined, so `undefined` never reaches canonicalJson. */
export function requestBody(o: LlmOpts): RequestBody {
  return {
    role: o.role,
    model: o.model,
    system: o.system,
    user: o.user,
    schema: o.jsonSchema ?? null,
    params: {
      max_tokens: o.params?.max_tokens ?? DEFAULT_MAX_TOKENS,
      reasoning: o.params?.reasoning ?? null,
      seed: o.params?.seed ?? null,
      temperature: o.params?.temperature ?? null,
    },
  };
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Lowercase hex sha256 of the UTF-8 bytes of the canonical JSON of the body. */
export function hashOfBody(body: object): string {
  return sha256Hex(canonicalJson(body));
}

export function requestHashOf(o: LlmOpts): string {
  return hashOfBody(requestBody(o));
}

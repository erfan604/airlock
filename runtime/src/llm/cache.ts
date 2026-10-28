// Recordings: one JSON file per request hash. The file holds the effective request, the exact response bytes, their hashes and
// the labels of the route that produced them. No header, no key, no environment value is ever written. The file is pure
// ASCII (every UTF-16 unit above 0x7F is a backslash-u escape), because model output holds em dashes and attack text is
// non-ASCII at times, and the pre-commit hook refuses a literal em dash in staged lines. Reading recomputes everything.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BadRecording } from './errors.ts';
import { hashOfBody, requestBody, requestHashOf, sha256Hex } from './hash.ts';
import { isStandInRoute } from './models.ts';
import { parseChat } from './parse.ts';
import type { LlmOpts, LlmResult } from './types.ts';

const HASH = /^[0-9a-f]{64}$/;
// a route is a short lowercase label the fixture builder chooses; `nearai` is the one this client's own calls carry
const ROUTE = /^[a-z][a-z0-9_.-]{0,31}$/;

/** `LLM_RECORDINGS_DIR` (absolute) or `runtime/recordings/` next to this module, whatever the working directory. */
export function recordingsDir(env: Record<string, string | undefined>): string {
  const set = env.LLM_RECORDINGS_DIR;
  if (set !== undefined && set !== '') {
    if (!isAbsolute(set)) throw new Error('LLM_RECORDINGS_DIR must be an absolute path');
    return set;
  }
  return resolve(fileURLToPath(new URL('../../recordings/', import.meta.url)));
}

const RecordingSchema = z.strictObject({
  version: z.literal(1),
  requestHash: z.string().regex(HASH),
  request: z.strictObject({
    role: z.enum(['planner', 'quarantine', 'vanilla']),
    model: z.string(),
    system: z.string(),
    user: z.string(),
    schema: z.union([z.null(), z.record(z.string(), z.unknown())]),
    params: z.strictObject({
      max_tokens: z.int(),
      reasoning: z.union([z.literal('low'), z.null()]),
      seed: z.union([z.int(), z.null()]),
      temperature: z.union([z.number(), z.null()]),
    }),
  }),
  responseBody: z.string(),
  responseHash: z.string().regex(HASH),
  latencyMs: z.int().min(0),
  recordedAt: z.string(),
  route: z.string().regex(ROUTE),
  sourceModel: z.string().min(1),
  effort: z.union([z.string(), z.null()]),
  isStandIn: z.boolean(),
});

export interface RecordingMeta {
  route: string;
  sourceModel?: string;
  effort?: string | null;
  latencyMs?: number;
  recordedAt?: string;
}

let tmpCounter = 0;

// every UTF-16 unit above 0x7F as a lowercase backslash-u escape; the escaped file parses back to the same strings
function asciiOnly(text: string): string {
  return text.replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * Writes `<dir>/<requestHash>.json` atomically (a temporary file, then a rename) and returns the hash. Used by `record` and by
 * fixture builders. `meta.route` has no default: a missing or empty one throws before any file is written, so a builder that
 * forgets it cannot label Groq text as `nearai`.
 */
export async function writeRecording(dir: string, o: LlmOpts, responseBody: string, meta: RecordingMeta): Promise<string> {
  if (typeof meta?.route !== 'string' || !ROUTE.test(meta.route)) throw new Error('writeRecording needs a route: a short lowercase name');
  const latencyMs = meta.latencyMs ?? 0;
  const recordedAt = meta.recordedAt ?? new Date().toISOString();
  const sourceModel = meta.sourceModel ?? o.model;
  const hash = requestHashOf(o);
  // a body that cannot be parsed never lands on disk
  parseChat(responseBody, o, hash, { recordedAt, latencyMs, route: meta.route, sourceModel });
  const rec = {
    version: 1,
    requestHash: hash,
    request: requestBody(o),
    responseBody,
    responseHash: sha256Hex(responseBody),
    latencyMs,
    recordedAt,
    route: meta.route,
    sourceModel,
    effort: meta.effort !== undefined ? meta.effort : (o.params?.reasoning ?? null),
    isStandIn: isStandInRoute(meta.route),
  };
  await mkdir(dir, { recursive: true });
  const final = join(dir, `${hash}.json`);
  const tmp = `${final}.tmp-${process.pid}-${tmpCounter++}`;
  try {
    await writeFile(tmp, asciiOnly(JSON.stringify(rec, null, 1)) + '\n', 'utf8');
    await rename(tmp, final);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  return hash;
}

/**
 * The recording of a request hash as an LlmResult, or null when the file is absent. Anything else wrong with the file (unreadable
 * JSON, an unknown or missing key, a hash that does not recompute, a label that does not match the route) is BadRecording.
 */
export async function readRecording(dir: string, hash: string): Promise<LlmResult | null> {
  if (!HASH.test(hash)) throw new BadRecording('invalid hash');
  let text: string;
  try {
    text = await readFile(join(dir, `${hash}.json`), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const rec = RecordingSchema.parse(JSON.parse(text));
    if (rec.requestHash !== hash || hashOfBody(rec.request) !== hash) throw new Error('request hash');
    if (sha256Hex(rec.responseBody) !== rec.responseHash) throw new Error('response hash');
    if (rec.isStandIn !== isStandInRoute(rec.route)) throw new Error('route label');
    const { role, model, system, user } = rec.request;
    return parseChat(rec.responseBody, { role, model, system, user }, hash, {
      recordedAt: rec.recordedAt,
      latencyMs: rec.latencyMs,
      route: rec.route,
      sourceModel: rec.sourceModel,
    });
  } catch {
    // whatever is wrong, the message names only the hash: the reason could echo file content
    throw new BadRecording(hash);
  }
}

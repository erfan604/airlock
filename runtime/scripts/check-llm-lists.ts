// Compares the code constants of the LLM client with the live public listings of NEAR AI Cloud (no key; this script is the one
// place a check touches the network). Every allowlisted id must be listed, every price must equal the listing by exact decimal
// arithmetic, and the model list must not be truncated by its page size. Prints one line per mismatch and `LISTS OK` last,
// else exits 1; a fetch that keeps failing exits 2.
//   usage: tsx scripts/check-llm-lists.ts [--config <path to models.json>]
import { readFileSync } from 'node:fs';
import { PRICES, TEE_MODELS, VANILLA_MODELS } from '../src/llm/index.ts';

const MODELS_URL = 'https://cloud-api.near.ai/v1/models';
const LIST_URL = 'https://cloud-api.near.ai/v1/model/list?limit=100';
const PLACES = 24;
const MILLION = 1_000_000n;

async function getJson(url: string): Promise<unknown> {
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (response.ok) return await response.json();
      last = `HTTP ${response.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : 'fetch failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  console.error(`fetch of ${url} failed 3 times: ${last}`);
  process.exit(2);
}

// a plain decimal as an integer count of 10^-24, or null for anything else (an exponent, a sign, too many places)
function scaled(text: unknown): bigint | null {
  if (typeof text !== 'string' || !/^[0-9]+(\.[0-9]+)?$/.test(text)) return null;
  const [whole = '', fraction = ''] = text.split('.');
  if (fraction.length > PLACES) return null;
  return BigInt(whole + fraction.padEnd(PLACES, '0'));
}

const asObject = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

async function main(): Promise<void> {
  const mismatches: string[] = [];
  const info: string[] = [];

  // the ids to check: the vanilla allowlist, plus the roles of a models config when one is given
  const wanted = new Set<string>(VANILLA_MODELS);
  const flag = process.argv.indexOf('--config');
  if (flag >= 0) {
    const path = process.argv[flag + 1];
    if (path === undefined) {
      console.error('--config needs a path');
      process.exit(2);
    }
    const config = asObject(JSON.parse(readFileSync(path, 'utf8')));
    for (const key of ['planner', 'quarantine'] as const) {
      const id = config[key];
      if (typeof id === 'string') wanted.add(id);
      else mismatches.push(`config: ${key} is not a model id`);
    }
    const vanilla = config.vanilla;
    if (Array.isArray(vanilla)) for (const id of vanilla) typeof id === 'string' ? wanted.add(id) : mismatches.push('config: a vanilla entry is not a model id');
    else mismatches.push('config: vanilla is not a list');
  }

  const listing = asObject(await getJson(MODELS_URL));
  const entries = Array.isArray(listing.data) ? listing.data.map(asObject) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) if (typeof entry.id === 'string') byId.set(entry.id, entry);

  for (const id of [...wanted].sort()) if (!byId.has(id)) mismatches.push(`not listed: ${id}`);

  for (const [id, price] of Object.entries(PRICES)) {
    const pricing = asObject(byId.get(id)?.pricing);
    for (const [side, ours, theirs] of [
      ['in', price.in, pricing.prompt],
      ['out', price.out, pricing.completion],
    ] as const) {
      const live = scaled(theirs);
      const mine = scaled(ours);
      if (live === null || mine === null || live * MILLION !== mine) {
        mismatches.push(`price ${id} ${side}: code ${ours} per million, listing ${String(theirs)} per token`);
      }
    }
  }

  // the model list pages at 100 by default: a catalogue past the page size would hide a missing id
  const list = asObject(await getJson(LIST_URL));
  const total = list.total;
  const limit = list.limit;
  if (typeof total !== 'number' || typeof limit !== 'number') mismatches.push('model/list has no numeric total and limit');
  else if (total > limit) mismatches.push(`model/list is truncated: total ${total} is above limit ${limit}`);
  const models = Array.isArray(list.models) ? list.models.map(asObject) : [];
  for (const id of TEE_MODELS) {
    const entry = models.find((m) => m.modelId === id);
    const metadata = asObject(entry?.metadata);
    info.push(`info: ${id} providerType=${String(metadata.providerType)} attestationSupported=${String(metadata.attestationSupported)} owned_by=${String(asObject(byId.get(id)).owned_by)}`);
  }

  for (const line of info) console.log(line);
  for (const line of mismatches) console.log(`MISMATCH ${line}`);
  if (mismatches.length > 0) process.exit(1);
  console.log('LISTS OK');
}

await main();

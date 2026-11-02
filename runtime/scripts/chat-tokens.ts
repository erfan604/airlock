// Generates runtime/config/chat-tokens.json (AIR-290): for each NEAR-operated quarantine model, the chat-template control tokens
// read from the model's own public tokenizer and chat-template files. Nothing is typed by hand. No key; network.
//   usage: tsx scripts/chat-tokens.ts [--check]
// Without --check it writes the file. With --check it writes nothing and compares what it fetches with the committed file.
// Prints one line per model with the token count (never the strings) and `CHAT TOKENS OK` last. Exit 1 on a mismatch or when a
// model has no repository id or no readable file (the id is named); exit 2 after 3 failed fetches.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LIST_URL = 'https://cloud-api.near.ai/v1/model/list?limit=100';
const OUT = fileURLToPath(new URL('../config/chat-tokens.json', import.meta.url));
const MODELS = ['Qwen/Qwen3.8-27B', 'Qwen/Qwen3.6-35B-A3B-FP8', 'z-ai/glm-5.3-flash'] as const;
// repositories that serve a model besides the one NEAR lists (the GLM recipe serves a quantized copy with its own config files)
const EXTRA_REPOS: Record<string, readonly string[]> = { 'z-ai/glm-5.3-flash': ['graphistry/GLM-5.3-Flash-W4AFP8'] };
const FILES = ['tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja'] as const;
const NAMED_KEYS = ['bos_token', 'eos_token', 'pad_token', 'unk_token', 'sep_token', 'cls_token', 'mask_token'] as const;

type FileRecord = { url: string; sha256: string };
type Entry = { source: string; sha256: string; repos: string[]; files: FileRecord[]; tokens: string[] };

class Failure extends Error {}

async function getBytes(url: string): Promise<Uint8Array> {
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      if (response.status === 404) throw new Failure(`no file at ${url}`);
      last = `HTTP ${response.status}`;
    } catch (e) {
      if (e instanceof Failure) throw e;
      last = e instanceof Error ? e.message : 'fetch failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  console.error(`fetch of ${url} failed 3 times: ${last}`);
  process.exit(2);
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const asObject = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asText = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);

function parseJson(bytes: Uint8Array, url: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(asText(bytes)));
  } catch {
    throw new Failure(`unreadable file ${url}`);
  }
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (typeof v === 'object' && v !== null) return Object.values(v).flatMap(strings);
  return [];
}

// a token entry is a plain string or an object with a `content` string (the AddedToken form)
function contentOf(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  const content = asObject(v).content;
  return typeof content === 'string' ? [content] : [];
}

// the markup literals of a chat template: angle or bracket shaped only, so no plain word enters a list
function templateLiterals(template: string): string[] {
  const patterns = [/<\|[^|<>\s]{1,40}\|>/g, /<\/?[A-Za-z][A-Za-z0-9_]{0,30}(?:=|>)/g, /\[[A-Za-z]{2,20}\]/g];
  return patterns.flatMap((p) => template.match(p) ?? []);
}

async function readRepo(repo: string, id: string): Promise<{ tokens: Set<string>; files: FileRecord[]; warn: string[] }> {
  const files: FileRecord[] = [];
  const bytes: Record<string, Uint8Array> = {};
  for (const name of FILES) {
    const url = `https://huggingface.co/${repo}/resolve/main/${name}`;
    try {
      bytes[name] = await getBytes(url);
    } catch (e) {
      throw new Failure(`${id}: ${e instanceof Failure ? e.message : 'unreadable file'} (repository ${repo})`);
    }
    files.push({ url, sha256: sha256(bytes[name] as Uint8Array) });
  }
  const tokenizer = parseJson(bytes['tokenizer.json'] as Uint8Array, `${repo}/tokenizer.json`);
  const config = parseJson(bytes['tokenizer_config.json'] as Uint8Array, `${repo}/tokenizer_config.json`);
  const template = asText(bytes['chat_template.jinja'] as Uint8Array);

  const fromTokenizer = new Set((Array.isArray(tokenizer.added_tokens) ? tokenizer.added_tokens : []).flatMap(contentOf));
  const fromConfig = new Set(Object.values(asObject(config.added_tokens_decoder)).flatMap(contentOf));
  const warn: string[] = [];
  if (fromConfig.size > 0 && (fromTokenizer.size !== fromConfig.size || [...fromConfig].some((t) => !fromTokenizer.has(t)))) {
    warn.push(`WARN sources disagree ${id} (${repo}): tokenizer.json ${fromTokenizer.size}, tokenizer_config.json ${fromConfig.size}`);
  }
  const tokens = new Set<string>([...fromTokenizer, ...fromConfig]);
  for (const key of NAMED_KEYS) for (const t of contentOf(config[key])) tokens.add(t);
  for (const key of ['additional_special_tokens', 'extra_special_tokens'] as const) for (const t of strings(config[key])) tokens.add(t);
  for (const t of templateLiterals(template)) tokens.add(t);
  tokens.delete('');
  return { tokens, files, warn };
}

async function build(id: string, repoId: string | undefined): Promise<{ entry: Entry; warn: string[] }> {
  if (repoId === undefined) throw new Failure(`${id}: the listing has no huggingFaceId`);
  const repos = [repoId, ...(EXTRA_REPOS[id] ?? [])];
  const tokens = new Set<string>();
  const files: FileRecord[] = [];
  const warn: string[] = [];
  for (const repo of repos) {
    const got = await readRepo(repo, id);
    for (const t of got.tokens) tokens.add(t);
    files.push(...got.files);
    warn.push(...got.warn);
  }
  const first = files[0];
  if (first === undefined) throw new Failure(`${id}: no files read`);
  // one digest over the digests of every file read, in the order read: any changed byte in any file changes it
  const combined = sha256(files.map((f) => `${f.url} ${f.sha256}\n`).join(''));
  return { entry: { source: first.url, sha256: combined, repos, files, tokens: [...tokens].sort() }, warn };
}

// ASCII only: every unit above 0x7F is written as a \uXXXX escape
function asciiJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const list = asObject(JSON.parse(asText(await getBytes(LIST_URL))));
  const listed = Array.isArray(list.models) ? list.models.map(asObject) : [];
  const out: Record<string, Entry> = {};
  const lines: string[] = [];
  const problems: string[] = [];
  for (const id of MODELS) {
    const hf = asObject(listed.find((m) => m.modelId === id)?.metadata).huggingFaceId;
    try {
      const { entry, warn } = await build(id, typeof hf === 'string' && hf.length > 0 ? hf : undefined);
      out[id] = entry;
      for (const w of warn) console.log(w);
      lines.push(`${id} ${entry.tokens.length} tokens from ${entry.repos.join(' + ')}`);
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      problems.push(e.message);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.log(`MISMATCH ${p}`);
    process.exit(1);
  }
  if (check) {
    let committed: Record<string, unknown> = {};
    try {
      committed = asObject(JSON.parse(readFileSync(OUT, 'utf8')));
    } catch {
      problems.push('runtime/config/chat-tokens.json is missing or unreadable');
    }
    for (const id of MODELS) {
      const have = asObject(committed[id]);
      const want = out[id];
      if (want === undefined || have.sha256 !== want.sha256 || JSON.stringify(have.tokens) !== JSON.stringify(want.tokens)) {
        problems.push(`${id}: the committed list differs from the model's files`);
      }
    }
    for (const id of Object.keys(committed)) if (!(MODELS as readonly string[]).includes(id)) problems.push(`${id}: committed entry has no source here`);
  } else {
    writeFileSync(OUT, asciiJson(out));
  }
  for (const line of lines) console.log(line);
  if (problems.length > 0) {
    for (const p of problems) console.log(`MISMATCH ${p}`);
    process.exit(1);
  }
  console.log('CHAT TOKENS OK');
}

await main();

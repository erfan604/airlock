// AIR-285 (proof part, built on AIR-302): committed, timestamped transcripts of the three heavy proof runs, so a reader with only Node
// (no Rust, Kani or Lean) can read what they printed, and a checker that fails when a transcript is stale against the source it covers.
//
//   pnpm tsx scripts/proof-transcripts.ts           check (default, Node only, a few seconds): exit 0 and last line PROOF TRANSCRIPTS OK <n>
//   pnpm tsx scripts/proof-transcripts.ts --record  runs the real proofs once (about 5 minutes) and rewrites docs/evidence/{kani,lean-axioms,diff-verdict}.txt
//                                                    and docs/evidence/proofs.json; needs Rust, Kani, Lean; refuses when a covered file differs from HEAD
//   pnpm tsx scripts/proof-transcripts.ts --inner <kani|lean|diff>   the command a transcript records (used by --record)
//
// Each transcript is written by scripts/evidence-transcript.sh (header sha=<commit> date=<UTC> tools=<versions>, cmd=, raw output, exit=).
// docs/evidence/proofs.json holds, per transcript, the list of source files it covers with the sha256 of each, one combined hash, and the
// sha256 of the transcript itself. The check recomputes all of them from the working tree, so editing a covered file (or a transcript)
// without re-recording fails and names the file. The single list of what is proven stays docs/proven.json: the check also requires every
// Lean theorem and Kani harness it names to appear in the matching transcript, and the differential line `identical on 40000 cases`.
// Erasable TypeScript, standard library only.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, loadSource, parseKaniLog } from './proven-lib.ts';

const EVIDENCE = path.join(ROOT, 'docs', 'evidence');
const MANIFEST = path.join(EVIDENCE, 'proofs.json');
const NAMES = ['kani', 'lean-axioms', 'diff-verdict'] as const;
type Name = (typeof NAMES)[number];

const VERDICT = 'contracts/airlock-verdict/';
const rustSource = (f: string) =>
  (f.startsWith(VERDICT + 'src/') || f.startsWith(VERDICT + 'examples/diff.rs')) ||
  [VERDICT + 'Cargo.toml', VERDICT + 'Cargo.lock', VERDICT + 'rust-toolchain.toml', VERDICT + 'harnesses.toml'].includes(f);
const leanSource = (f: string) =>
  /^proofs\/[^/]+\.lean$/.test(f) || /^proofs\/claims\/[^/]+\.lean$/.test(f) ||
  ['proofs/comparator.json', 'proofs/lakefile.toml', 'proofs/lean-toolchain', 'proofs/lake-manifest.json'].includes(f);

type Spec = { cmd: string[]; label: string; covers: (f: string) => boolean; scripts: string[] };
const SPECS: Record<Name, Spec> = {
  kani: {
    cmd: ['scripts/kani-check.sh'],
    label: 'scripts/kani-check.sh, then one line per harness from its log',
    covers: rustSource,
    scripts: ['scripts/kani-check.sh', 'scripts/kani_parse.py'],
  },
  'lean-axioms': {
    cmd: ['scripts/lean-axioms.sh'],
    label: 'scripts/lean-axioms.sh, then the axioms each theorem uses',
    covers: leanSource,
    scripts: ['scripts/lean-axioms.sh'],
  },
  'diff-verdict': {
    cmd: ['scripts/diff-verdict.sh', '--commit'],
    label: 'scripts/diff-verdict.sh --commit',
    covers: (f) => rustSource(f) || leanSource(f),
    scripts: ['scripts/diff-verdict.sh', 'scripts/gen_verdict_cases.py', 'scripts/diff-report.py'],
  },
};

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr ?? '').trim());
  return r.stdout;
}

/** The covered files of one transcript: tracked files only, sorted, so a stray file in the tree cannot change a hash. */
function coveredFiles(name: Name): string[] {
  const spec = SPECS[name];
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  return tracked.filter((f) => spec.covers(f) || spec.scripts.includes(f)).sort();
}

function hashFiles(files: string[]): { files: Record<string, string>; combined: string } {
  const out: Record<string, string> = {};
  for (const f of files) out[f] = fs.existsSync(path.join(ROOT, f)) ? sha256(fs.readFileSync(path.join(ROOT, f))) : 'missing';
  const combined = sha256(files.map((f) => f + ' ' + out[f] + '\n').join(''));
  return { files: out, combined };
}

type Manifest = {
  note: string;
  transcripts: Record<string, { file: string; sha: string; covers: Record<string, string>; coversSha256: string; transcriptSha256: string }>;
};

// ---------------------------------------------------------------- inner commands (what a transcript records)

function run(cmd: string[]): number {
  const r = spawnSync(cmd[0] as string, cmd.slice(1), { cwd: ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

function inner(name: string): number {
  if (name === 'kani') {
    const rc = run(['scripts/kani-check.sh']);
    const log = path.join(ROOT, 'target', 'kani.log');
    if (!fs.existsSync(log)) return 1;
    const m = parseKaniLog(fs.readFileSync(log, 'utf8'));
    for (const [h, s] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`HARNESS ${h} VERIFICATION ${s}`);
    console.log(`HARNESSES ${m.size}`);
    return rc;
  }
  if (name === 'lean') {
    const rc = run(['scripts/lean-axioms.sh']);
    const log = path.join(ROOT, 'target', 'lake-check.log');
    if (fs.existsSync(log)) {
      for (const l of fs.readFileSync(log, 'utf8').split('\n')) {
        const m = /'([A-Za-z0-9_.]+)' (depends on axioms: \[[^\]]*\]|does not depend on any axioms)/.exec(l);
        if (m) console.log(`THEOREM ${m[1]} ${m[2]}`);
      }
    }
    return rc;
  }
  if (name === 'diff') return run(['scripts/diff-verdict.sh', '--commit']);
  console.error('usage: --inner <kani|lean|diff>');
  return 2;
}

// ---------------------------------------------------------------- record

function record(): number {
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean);
  const all = new Set(NAMES.flatMap((n) => coveredFiles(n)));
  const bad = dirty.filter((l) => all.has(l.slice(3)));
  if (bad.length) {
    console.log('PROOF TRANSCRIPTS RECORD REFUSED: covered files differ from HEAD, commit them first so the header sha is the commit that was proven:');
    for (const l of bad) console.log('  ' + l);
    return 2;
  }
  const inners: Record<Name, string> = { kani: 'kani', 'lean-axioms': 'lean', 'diff-verdict': 'diff' };
  const manifest: Manifest = {
    note: 'Written by scripts/proof-transcripts.ts --record. Check with: pnpm tsx scripts/proof-transcripts.ts',
    transcripts: {},
  };
  fs.mkdirSync(EVIDENCE, { recursive: true });
  for (const name of NAMES) {
    console.log(`== recording ${name}`);
    const r = spawnSync(
      'scripts/evidence-transcript.sh',
      [name, '--', 'pnpm', 'tsx', 'scripts/proof-transcripts.ts', '--inner', inners[name]],
      { cwd: ROOT, stdio: 'inherit', env: { ...process.env, EVIDENCE_CMD_LABEL: SPECS[name].label } },
    );
    if (r.status !== 0) {
      console.log(`PROOF TRANSCRIPTS RECORD FAILED at ${name} (exit ${r.status}); the transcript was still written, nothing else was`);
      return 1;
    }
    const file = path.join(EVIDENCE, name + '.txt');
    const header = /^sha=([0-9a-f]{40}) /.exec(fs.readFileSync(file, 'utf8').split('\n')[0] as string);
    const h = hashFiles(coveredFiles(name));
    manifest.transcripts[name] = {
      file: 'docs/evidence/' + name + '.txt',
      sha: header ? (header[1] as string) : '',
      covers: h.files,
      coversSha256: h.combined,
      transcriptSha256: sha256(fs.readFileSync(file)),
    };
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log('wrote docs/evidence/proofs.json');
  return check();
}

// ---------------------------------------------------------------- check

function check(): number {
  const problems: string[] = [];
  const fail = (s: string) => problems.push(s);
  if (!fs.existsSync(MANIFEST)) {
    console.log('FAIL docs/evidence/proofs.json is missing: run pnpm tsx scripts/proof-transcripts.ts --record');
    console.log('PROOF TRANSCRIPTS FAIL 1');
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
  const src = loadSource();
  const text: Partial<Record<Name, string>> = {};
  for (const name of NAMES) {
    const m = manifest.transcripts[name];
    const file = path.join(EVIDENCE, name + '.txt');
    if (!m) {
      fail(`${name}: no entry in docs/evidence/proofs.json`);
      continue;
    }
    if (!fs.existsSync(file)) {
      fail(`${name}: docs/evidence/${name}.txt is missing`);
      continue;
    }
    const raw = fs.readFileSync(file);
    const t = raw.toString('utf8');
    text[name] = t;
    const lines = t.split('\n');
    const hm = /^sha=([0-9a-f]{40}) date=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) tools=(.+)$/.exec(lines[0] as string);
    if (!hm) fail(`${name}: line 1 is not "sha=<40 hex> date=<UTC> tools=<versions>"`);
    else {
      if (hm[1] !== m.sha) fail(`${name}: header sha ${hm[1]} differs from proofs.json (${m.sha})`);
      const known = spawnSync('git', ['cat-file', '-e', hm[1] + '^{commit}'], { cwd: ROOT }).status === 0;
      // a shallow clone (git clone --depth 1, the CI default) has no older commits to look up; the file hashes below still decide staleness
      const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() === 'true';
      if (!known && shallow) console.log(`SKIP ${name}: header commit ${hm[1].slice(0, 12)} not checked, this is a shallow clone (file hashes still checked)`);
      else if (!known) fail(`${name}: the commit ${hm[1]} named in the header is not in this repository`);
      if (/=none/.test(hm[3] as string) && name === 'kani' && /kani=none/.test(hm[3] as string)) fail(`${name}: header says no kani version`);
    }
    if (!/^cmd=.+/.test(lines[1] as string)) fail(`${name}: line 2 is not cmd=<command>`);
    if (lines.filter(Boolean).pop() !== 'exit=0') fail(`${name}: the transcript does not end with exit=0`);
    if (sha256(raw) !== m.transcriptSha256) fail(`${name}: the transcript was edited after it was recorded (sha256 differs from proofs.json)`);
    const now = hashFiles(coveredFiles(name));
    if (now.combined !== m.coversSha256) {
      const changed = new Set([...Object.keys(now.files), ...Object.keys(m.covers)].filter((f) => now.files[f] !== m.covers[f]));
      fail(`${name}: STALE, ${changed.size} covered file(s) changed since it was recorded: ${[...changed].slice(0, 8).join(', ')}. Re-record: pnpm tsx scripts/proof-transcripts.ts --record`);
    }
  }
  // every name docs/proven.json lists must be in the matching transcript
  const kani = text.kani ?? '';
  const lean = text['lean-axioms'] ?? '';
  const diff = text['diff-verdict'] ?? '';
  const seen = new Set<string>();
  for (const e of src.entries) {
    for (const p of e.proofs) {
      const key = p.kind + ':' + p.name;
      if (seen.has(key)) continue;
      seen.add(key);
      if (p.kind === 'kani' && !kani.includes(`HARNESS ${p.name} VERIFICATION SUCCESSFUL`)) fail(`kani harness ${p.name} (entry ${e.id}) is not shown as verified in docs/evidence/kani.txt`);
      if (p.kind === 'lean' && !new RegExp(`THEOREM (\\S+\\.)?${p.name} (depends on axioms: \\[[^\\]]*\\]|does not depend)`).test(lean)) fail(`lean theorem ${p.name} (entry ${e.id}) has no axiom line in docs/evidence/lean-axioms.txt`);
      if (p.kind === 'lean' && /sorryAx|native_decide|ofReduceBool/.test(lean)) fail(`docs/evidence/lean-axioms.txt lists a forbidden axiom`);
    }
  }
  if (kani && !/^KANI OK: /m.test(kani)) fail('kani: no KANI OK line');
  if (lean && !(/^AXIOMS OK: /m.test(lean) && /^LEANCHECKER OK$/m.test(lean))) fail('lean-axioms: no AXIOMS OK and LEANCHECKER OK lines');
  if (diff && !/identical on 40000 cases/.test(diff)) fail('diff-verdict: no "identical on 40000 cases" line');

  for (const p of problems) console.log('FAIL ' + p);
  if (problems.length) {
    console.log('PROOF TRANSCRIPTS FAIL ' + problems.length);
    return 1;
  }
  console.log('PROOF TRANSCRIPTS OK ' + NAMES.length);
  return 0;
}

const flag = process.argv[2];
if (flag === '--inner') process.exit(inner(process.argv[3] ?? ''));
else if (flag === '--record') process.exit(record());
else if (flag === undefined) process.exit(check());
else {
  console.error('usage: scripts/proof-transcripts.ts [--record]');
  process.exit(2);
}

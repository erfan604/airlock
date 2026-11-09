// AIR-311: the text files of the static site for machine readers, written by scripts/prerender.tsx from the sources the pages use, so they cannot
// drift from the site or the README:
//   llms.txt       the llmstxt.org index: H1, a one-line summary, the pages and the raw data with one line each
//   llms-full.txt  a plain-text digest: README sections copied verbatim (summary, what is different, the result, the problem, proven, verify,
//                  limits, deployed ids), the bench numbers from bench.json, the Try page's two scenarios with their verdicts, the recorded acts
//                  with their transactions, and every testnet transaction link of docs/EVIDENCE.md under its section
//   robots.txt     everything allowed, with the sitemap
//   sitemap.xml    every page of src/pages.ts that is not an alias
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BenchData, Table } from '../src/bench/types.ts';
import type { Facts } from '../src/landing/facts.ts';
import { PAGES, pageUrl } from '../src/pages.ts';
import type { ActSummary } from '../src/replay/summary.ts';
import { HIRED, WORLD, defaultKnobs, formatDollars, parseDollars, sourceOf, standIn } from '../src/try/model.ts';
import type { World } from '../src/try/model.ts';

const bookText = (w: World): string => w.book.map((b) => `${b.name} (${b.account}, usual bill ${formatDollars(parseDollars(b.usual) ?? 0n)} a ${b.every})`).join('; ');

const repo = resolve(import.meta.dirname, '..', '..');

/** The README section under `## <name>`, verbatim, up to the next `## ` heading (subsections included). */
export function readmeSection(readme: string, name: string): string {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => l === `## ${name}`);
  if (start < 0) throw new Error(`README has no section ${name}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

/** The README's opening: every paragraph between the H1 and the first `## ` heading. */
export function readmeIntro(readme: string): string {
  const lines = readme.split('\n');
  const end = lines.findIndex((l) => l.startsWith('## '));
  return lines.slice(1, end).join('\n').trim();
}

const README_SECTIONS = ['What is different', 'The result', 'The problem', 'Proven', 'Verify in 5 commands', 'AIRLOCK Credit', 'Limits', 'Deployed ids and hashes'];

function tableText(t: Table, rows?: (cells: string[]) => boolean): string {
  const body = t.rows.filter((r) => rows === undefined || rows(r.cells)).map((r) => `| ${r.cells.join(' | ')} |`);
  return [`| ${t.head.join(' | ')} |`, `| ${t.head.map(() => '---').join(' | ')} |`, ...body].join('\n');
}

/** Every testnet transaction link of docs/EVIDENCE.md, under the section heading it appears in. */
export function evidenceLinks(evidence: string): { section: string; urls: string[] }[] {
  const out: { section: string; urls: string[] }[] = [];
  let section = 'Evidence log';
  const seen = new Set<string>();
  for (const line of evidence.split('\n')) {
    if (line.startsWith('## ')) section = line.slice(3).trim();
    for (const m of line.matchAll(/https:\/\/(?:testnet\.nearblocks\.io\/txns|sepolia\.basescan\.org\/tx)\/[A-Za-z0-9]+/g)) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      const last = out.at(-1);
      if (last !== undefined && last.section === section) last.urls.push(m[0]);
      else out.push({ section, urls: [m[0]] });
    }
  }
  return out;
}

const tagWords = (tag: string): string => {
  const [kind, rule] = tag.split(':');
  const word = kind === 'allow' ? 'ALLOWED (paid)' : kind === 'block' ? 'BLOCKED' : 'HELD for the owner';
  return rule === undefined ? word : `${word}, rule ${rule}`;
};

export type LlmsInput = { out: string; base: string; origin: string; bench: BenchData; facts: Facts | null; replay: ActSummary[] };

export function llmsTxt(i: LlmsInput, summary: string): string {
  const abs = (p: string): string => `${i.origin}${i.base}${p.replace(/^\//, '')}`;
  const pages = PAGES.filter((p) => p.alias === undefined).map((p) => `- [${p.title.replace(/ \| AIRLOCK$/, '')}](${pageUrl(i.origin, i.base, p.path)}): ${p.description}`);
  const runs = i.replay.flatMap((a) => (a.runId === null ? [] : [{ title: a.title, runId: a.runId }]));
  return [
    '# AIRLOCK',
    '',
    `> ${summary}`,
    '',
    'This site is a static copy with no server: the overview, a playground where the verdict crate of the NEAR contract, compiled to WebAssembly, decides on a scam email in the browser, a replay of recorded NEAR testnet runs, the bench results and the proofs. Every page is prerendered, so its text is in the HTML.',
    '',
    '## Pages',
    '',
    ...pages,
    `- [Try it with an agent you hired](${pageUrl(i.origin, i.base, '/try?s=hired')}): the Swarm-for-Hire scenario: the job budget is the task bound, the job's payees are the book, and the job post and every other agent's message are outside text`,
    '',
    '## Raw data',
    '',
    `- [Full digest](${abs('/llms-full.txt')}): one plain-text file with the README summary, the bench numbers, the Try page's scenarios (your bills, an agent you hired) and their verdicts, the recorded acts and every testnet transaction link`,
    `- [bench.json](${abs('/bench.json')}): every bench table the Bench page shows, written by the same function that writes docs/BENCH.md`,
    `- [Recorded acts](${abs('/data/replay/acts.json')}): the three acts of the recorded testnet run with their transaction links`,
    ...runs.map((a) => `- [Trace of ${a.title}](${abs(`/data/runs/${a.runId}.txt`)}): the recorded event stream of that run, as the replay server sent it`),
    `- [Tampered approval](${abs('/data/replay/tamper.json')}): the refused approval transaction and the contract's error`,
    `- [verdict.wasm](${abs('/verdict.wasm')}): the airlock-verdict crate built for wasm32-unknown-unknown; the repository's tests check it equals a fresh build and agrees with the Rust crate`,
    `- [Sitemap](${abs('/sitemap.xml')})`,
    '',
  ].join('\n');
}

export function llmsFull(i: LlmsInput, readme: string, evidence: string): string {
  const abs = (p: string): string => `${i.origin}${i.base}${p.replace(/^\//, '')}`;
  const f = i.facts;
  const pay = i.bench.completion.find((t) => t.title.startsWith('Benign payment tasks only'));
  const parts: string[] = [
    '# AIRLOCK, the full digest',
    '',
    `Generated at build time from the repository's README.md, docs/EVIDENCE.md, web/public/bench.json, web/fixtures/try-world.json, web/fixtures/try-hired.json and the recorded replay data. Site: ${abs('/')}. Every README section below is copied verbatim; the tags in square brackets ([C6], [PA18]) point at rows of docs/CLAIMS.md and docs/PRIOR_ART.md in the repository.`,
    '',
    '## Summary (README)',
    '',
    readmeIntro(readme),
    '',
  ];
  for (const s of README_SECTIONS) parts.push(`## ${s} (README)`, '', readmeSection(readme, s), '');
  parts.push('## Bench numbers (bench.json)', '', `Header: ${i.bench.header}.`, '');
  if (f !== null) {
    parts.push(
      `- ${f.bookedOfPaid.k} of ${f.bookedOfPaid.n} attacks that worked on the agent with no guard (V0) paid a payee already in the owner's address book.`,
      `- Strict mode A1: ${f.strict.k} of ${f.strict.n} attack runs moved money.`,
      `- Default mode A2: ${f.dflt.k} of ${f.dflt.n} attack runs moved money${f.residualCase === null ? '' : `, all ${f.residualRuns ?? ''} in one case (${f.residualCase}), where outside text raised an amount to a booked payee and stayed inside the owner's cap; strict mode holds it`}.`,
      `- Benign payment tasks (${f.payTasks}, the read-only tasks left out): A2 finishes ${f.honestAlone.k} of ${f.honestAlone.n} by itself, ${f.honestTapped.k} after one owner tap and ${f.honestFailed.k} do not finish; A1 finishes ${f.strictAlone.k} by itself and ${f.strictTapped.k} after one tap.`,
      '',
    );
  }
  parts.push('### Attack success, all attack runs (group ALL)', '', tableText(i.bench.attack, (c) => c[1] === 'ALL'), '');
  if (i.bench.breakdown !== undefined && i.bench.breakdown !== null) parts.push('### What the successful attacks did', '', tableText(i.bench.breakdown), '');
  if (pay !== undefined) parts.push(`### ${pay.title}`, '', tableText(pay), '');
  if (i.bench.residual !== null) parts.push(i.bench.residual.text, '');

  const worlds: { world: World; head: string; intro: string }[] = [
    {
      world: WORLD,
      head: '## The Try page, your bills: five emails and their verdicts (web/fixtures/try-world.json)',
      intro: `The owner asked: "${WORLD.owner.request}" Address book: ${bookText(WORLD)}. Default mode caps amounts read from an email at ${formatDollars(defaultKnobs(WORLD).capCents)}; strict mode has no cap.`,
    },
    {
      world: HIRED,
      head: '## The Try page, an agent you hired (Swarm-for-Hire): four texts and their verdicts (web/fixtures/try-hired.json)',
      intro: `A worker agent takes a posted job: "${HIRED.owner.request}" The job budget, ${formatDollars(parseDollars(HIRED.limits.taskBound) ?? 0n)}, is the task bound; the job's payees are the book: ${bookText(HIRED)}; the job post and every other agent's message are outside text. Default mode caps amounts read from outside text at ${formatDollars(defaultKnobs(HIRED).capCents)}; strict mode has no cap. This is a scenario on the shipped verdict, not a benchmarked case.`,
    },
  ];
  for (const { world, head, intro } of worlds) {
    parts.push(head, '', `${intro} The agent on the page is a stand-in (pattern matching, not a model) that does whatever the text says. The verdicts below are the expected values that the repository's tests check against the WebAssembly build of the verdict crate.`, '');
    for (const p of world.presets) {
      const a = standIn(p.email, world, sourceOf(p));
      parts.push(
        `### ${p.title}`,
        '',
        p.line,
        '',
        `Text (${sourceOf(p).words}), from ${p.from}:`,
        '',
        ...p.email.split('\n').map((l) => `    ${l}`),
        '',
        `- The agent would pay: ${a.kind === 'proposal' ? `${a.proposal.payee.name ?? a.proposal.payee.account} (${a.proposal.payee.account}), ${formatDollars(a.proposal.amount.cents)}` : 'nothing'}`,
        `- AIRLOCK, default mode: ${tagWords(p.expect.default)}`,
        `- AIRLOCK, strict mode: ${tagWords(p.expect.strict)}`,
        `- A payee-list guard (payee on the list, amount under the per-payment cap): ${p.expect.guard === 'PAY' ? 'pays' : 'refuses'}`,
        '',
      );
    }
  }

  parts.push('## The recorded testnet run (data/replay)', '');
  for (const a of i.replay) {
    parts.push(`### ${a.title}`, '', `The owner asked: "${a.ownerWords}" Recorded ${a.recordedAt.slice(0, 10)} (${a.source}).`, '');
    if (a.outcome !== null) parts.push(`- Outcome: ${a.outcome.money}${a.outcome.to === null ? '' : ` to ${a.outcome.to}`}. ${a.outcome.sentence}${a.outcome.reason === null ? '' : ` (rule ${a.outcome.reason})`}`);
    if (a.failure !== null) parts.push(`- Contract error: ${a.failure}`);
    for (const l of a.links) parts.push(`- Transaction (${l.label}, ${l.status}): ${l.url}`);
    parts.push('');
  }

  parts.push('## Every testnet transaction in docs/EVIDENCE.md', '');
  for (const g of evidenceLinks(evidence)) parts.push(`### ${g.section}`, '', ...g.urls.map((u) => `- ${u}`), '');

  parts.push(
    '## Where things are',
    '',
    'Repository layout (README, Repo map): contracts/airlock-policy (the NEAR policy contract, Rust), contracts/airlock-verdict (the verdict, a pure no_std crate with Kani harnesses), proofs/ (Lean), runtime (TypeScript: plan DSL, interpreter, planner, quarantine, tools, chain), web (this console), bench (cases, runner, results), docs (CLAIMS, EVIDENCE, BENCH, PROVEN, VERIFY).',
    '',
  );
  return parts.join('\n');
}

export function writeLlmsFiles(i: LlmsInput): void {
  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  const evidence = readFileSync(join(repo, 'docs', 'EVIDENCE.md'), 'utf8');
  const summary = readme.split('\n').find((l, n) => n > 0 && l.trim() !== '') ?? '';
  const abs = (p: string): string => `${i.origin}${i.base}${p.replace(/^\//, '')}`;
  writeFileSync(join(i.out, 'llms.txt'), llmsTxt(i, summary));
  writeFileSync(join(i.out, 'llms-full.txt'), llmsFull(i, readme, evidence));
  writeFileSync(join(i.out, 'robots.txt'), ['User-agent: *', 'Allow: /', '', `Sitemap: ${abs('/sitemap.xml')}`, ''].join('\n'));
  writeFileSync(join(i.out, 'sitemap.xml'), sitemapXml(i.origin, i.base));
}

/** Every page that is not an alias, in the slash form the host serves. */
export function sitemapXml(origin: string, base: string): string {
  const urls = PAGES.filter((p) => p.alias === undefined).map((p) => `  <url><loc>${pageUrl(origin, base, p.path)}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}

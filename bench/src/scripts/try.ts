// pnpm try (AIR-256): play a corpus attack or your own email text through AIRLOCK's gate, offline, and see what a vanilla agent that pays what it
// reads would do next to what AIRLOCK decides and why. No chain, no key, no model. Usage:
//   pnpm try --self-test | --case <id> [--config A1|A2] | --file <path> [--config ...] | --text <string> [--config ...]
// `--file` resolves against INIT_CWD (the directory pnpm was started in). Pasted text is inert: it is never executed, evaluated or rendered, and
// every echo of it goes through escapeForTerminal.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureVerdictCli } from '../runner/backend.ts';
import { MAX_TEXT_CHARS, PRESETS, corpusCases, findCase, playCorpusCase, playText } from '../try/play.ts';
import type { TryConfig } from '../try/play.ts';
import { escapeForTerminal } from '../try/escape.ts';

const USAGE = 'usage: pnpm try --self-test | --case <id> | --file <path> | --text <string>  [--config A1|A2]';

interface Args {
  selfTest: boolean;
  caseId?: string;
  file?: string;
  text?: string;
  config: TryConfig;
}

function parseArgs(argv: readonly string[]): Args | string {
  const a: Args = { selfTest: false, config: 'A2' };
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i] as string;
    let value: string | undefined;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq > 0) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    const next = (): string | undefined => value ?? argv[++i];
    if (flag === '--self-test') a.selfTest = true;
    else if (flag === '--case') a.caseId = next();
    else if (flag === '--file') a.file = next();
    else if (flag === '--text') a.text = next();
    else if (flag === '--config') {
      const v = next();
      if (v !== 'A1' && v !== 'A2') return '--config takes A1 or A2';
      a.config = v;
    } else return `unknown argument ${escapeForTerminal(flag)}`;
  }
  const modes = [a.selfTest, a.caseId !== undefined, a.file !== undefined, a.text !== undefined].filter(Boolean).length;
  if (modes !== 1) return 'give exactly one of --self-test, --case, --file, --text';
  if ((a.caseId ?? a.file ?? a.text ?? '') === '' && !a.selfTest) return 'the value is empty';
  return a;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    console.error(`${args}\n${USAGE}`);
    return 2;
  }
  try {
    ensureVerdictCli();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('pnpm try needs the Rust toolchain once: see README');
      return 2;
    }
    throw e;
  }
  if (args.selfTest) {
    const cases = corpusCases();
    for (const id of PRESETS) {
      const c = findCase(cases, id);
      if (c === undefined) {
        console.log(`TRY SELF-TEST FAILED ${id}`);
        return 1;
      }
      const p = await playCorpusCase(c, 'A2');
      console.log(`${p.lines.join('\n')}\n`);
      const attacker = p.result.payments.filter((x) => x.attackerInfluenced);
      const vanillaPays = attacker.length > 0;
      const held = attacker.every((x) => x.outcome === 'ESCALATE' || x.outcome === 'BLOCK');
      if (!vanillaPays || !held) {
        console.log(`TRY SELF-TEST FAILED ${id}`);
        return 1;
      }
    }
    console.log(`TRY SELF-TEST OK ${PRESETS.length} cases`);
    return 0;
  }
  if (args.caseId !== undefined) {
    const c = findCase(corpusCases(), args.caseId);
    if (c === undefined) {
      console.error(`no corpus case ${escapeForTerminal(args.caseId)}`);
      return 2;
    }
    if (c.gate === null) {
      console.error(`case ${escapeForTerminal(c.id)} has no attacker path to play`);
      return 2;
    }
    console.log((await playCorpusCase(c, args.config)).lines.join('\n'));
    return 0;
  }
  let text = args.text ?? '';
  if (args.file !== undefined) {
    try {
      text = readFileSync(resolve(process.env['INIT_CWD'] ?? process.cwd(), args.file), 'utf8');
    } catch {
      console.error('the file cannot be read');
      return 2;
    }
  }
  if (text.length > MAX_TEXT_CHARS) {
    console.error(`the text is longer than ${MAX_TEXT_CHARS} characters`);
    return 2;
  }
  console.log((await playText(text, args.config)).lines.join('\n'));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(escapeForTerminal(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  },
);

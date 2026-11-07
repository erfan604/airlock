// AIR-319: everything the airlock-near-mcp command does before it serves: help, version, --print-config and --check. Split from cli.ts so a
// test can call it without starting a server.
import { ConfigError, HELP, UsageError, parseArgs, printConfig } from './args.ts';
import { runCheck } from './check.ts';

export const VERSION = '0.1.0';

/** Runs everything but serving. Returns the exit code, or null when the caller should serve. */
export async function run(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void, err: (line: string) => void): Promise<number | null> {
  try {
    const p = parseArgs(argv);
    if (p.help) {
      out(HELP.trimEnd());
      return 0;
    }
    if (p.version) {
      out(VERSION);
      return 0;
    }
    if (p.printConfig !== null) {
      out(printConfig(p.printConfig, p, env));
      return 0;
    }
    if (p.check) return (await runCheck(out)) ? 0 : 1;
    return null;
  } catch (e) {
    err(e instanceof UsageError || e instanceof ConfigError ? e.message : 'unexpected error');
    return 2;
  }
}

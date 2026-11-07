// AIR-319: the entry of the npm package airlock-near-mcp (the bin of the bundle). `--check` and `--print-config` need no key; the default mode
// serves the six tools of runtime/src/mcp over stdio, the same session and server as AIR-313 (runtime/src/mcp/boot.ts and server.ts).
// stdout carries the MCP protocol only in serve mode; every log line goes to stderr.
import { sessionFromConfig } from '../../../runtime/src/mcp/boot.ts';
import { assertTestnetNetwork } from '../../../runtime/src/mcp/network.ts';
import { createMcpServer } from '../../../runtime/src/mcp/server.ts';
import { parseArgs, resolveConfig } from './args.ts';
import { run } from './run.ts';
import { createStdioTransport } from '../../../runtime/src/mcp/stdio.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const code = await run(argv, process.env, (l) => process.stdout.write(`${l}\n`), (l) => process.stderr.write(`airlock-near-mcp: ${l}\n`));
  if (code !== null) {
    process.exitCode = code;
    return;
  }
  const cfg = resolveConfig(parseArgs(argv), process.env);
  await assertTestnetNetwork(cfg);
  const server = createMcpServer(sessionFromConfig(cfg));
  await server.connect(createStdioTransport());
  process.stderr.write(`airlock-near-mcp ready: policy ${cfg.contract_id}, agent ${cfg.agent_id}, ${cfg.network}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`airlock-near-mcp failed to start: ${e instanceof Error ? e.message : 'unknown error'}\n`);
  process.exit(1);
});

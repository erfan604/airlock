// airlock-mcp (AIR-313): the stdio entry an MCP client starts. It reads the owner's config (AIRLOCK_MCP_CONFIG, default ~/.airlock/mcp.json),
// builds the agent's chain client from the agent's credentials file and the task signer from the owner's task key seed file, and serves
// the six tools of server.ts on stdin and stdout. stdout carries the protocol only: every log line goes to stderr, and no key is printed.
// adapted from modelcontextprotocol/typescript-sdk@1.32.1 docs/server.md (MIT): `server.connect(createStdioTransport())`.
import { sessionFromConfig, taskSigner } from './boot.ts';
import { defaultConfigPath, loadConfig } from './config.ts';
import { assertTestnetNetwork } from './network.ts';
import { createMcpServer } from './server.ts';
import { createStdioTransport } from './stdio.ts';

export { sessionFromConfig, taskSigner };

async function main(): Promise<void> {
  const path = process.env.AIRLOCK_MCP_CONFIG ?? defaultConfigPath();
  const cfg = loadConfig(path);
  await assertTestnetNetwork(cfg);
  const server = createMcpServer(sessionFromConfig(cfg));
  await server.connect(createStdioTransport());
  process.stderr.write(`airlock-mcp ready: policy ${cfg.contract_id}, agent ${cfg.agent_id}, ${cfg.network}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    process.stderr.write(`airlock-mcp failed to start: ${e instanceof Error ? e.message : 'unknown error'}\n`);
    process.exit(1);
  });
}

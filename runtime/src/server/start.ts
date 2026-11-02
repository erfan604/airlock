// `pnpm -C runtime start`: the only file under runtime/src/server that reads the process environment (AIR-169).
import { startRuntime } from './main.ts';

try {
  const running = await startRuntime(process.env);
  console.log(`listening ${running.url}`);
} catch (error) {
  // ConfigError names variables and never values; every other start failure is named by its class and message, which carry no key
  console.error(error instanceof Error ? `${error.name === 'ConfigError' ? '' : `${error.name}: `}${error.message}` : 'start failed');
  process.exit(1);
}

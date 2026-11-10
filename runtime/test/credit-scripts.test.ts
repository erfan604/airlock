// AIR-355 and AIR-359: the tests of the strict-mode script, the economy loop and the agent renewal plan live next to their scripts. Loading them here makes
// `pnpm -C runtime test`, and with it scripts/check.sh quick, run them.
import '../../scripts/credit-strict.test.ts';
import '../../scripts/credit-economy.test.ts';
import '../../scripts/agent-renew.test.ts';

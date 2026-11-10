// AIR-336: the Credit Arena's tests live next to its script (scripts/credit-arena.test.ts). Loading them here makes `pnpm -C runtime test`,
// and with it scripts/check.sh quick, run them.
import '../../scripts/credit-arena.test.ts';

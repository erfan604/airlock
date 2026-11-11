// AIR-355 and AIR-359: the tests of the strict-mode script, the economy loop and the agent renewal plan live next to their scripts. Loading them here makes
// `pnpm -C runtime test`, and with it scripts/check.sh quick, run them.
import '../../scripts/credit-strict.test.ts';
import '../../scripts/credit-economy.test.ts';
import '../../scripts/agent-renew.test.ts';
// AIR-356: the try card's setup, publish and refill tests
import '../../scripts/try-setup.test.ts';
import '../../scripts/try-publish.test.ts';
import '../../scripts/try-refill.test.ts';
// the pool redeploy of 2026-11-11: the committed bytes and the storage run
import '../../scripts/credit-pool-code-check.test.ts';
// AIR-364: the uncensored-attacker run on the practice card
import '../../scripts/uncensored-run.test.ts';
// AIR-360: the bench replay on the practice card
import '../../scripts/try-replay.test.ts';
// red team 2026-11-11: the live proof of the approver bounds (its plan, stop rules, run and verify on a fake chain)
import '../../scripts/credit-approver-bounds-live.test.ts';

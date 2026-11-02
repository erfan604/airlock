// AIR-142 check 5: the first time the quarantine prompt and extractionSchema meet the real model. Run only with a live budget
// (see CLAUDE.md "Live LLM budget"):
//   set -a; . ~/.airlock-research.env; set +a; LLM_MODE=live pnpm -C runtime exec tsx scripts/extract-smoke.ts
import { loadModelsConfig } from '../src/llm/index.ts';
import { extract } from '../src/quarantine/index.ts';

const TEXT = 'Invoice 17. Total due: 4.2 NEAR. Please pay by Friday.';

try {
  const out = await extract({ data: TEXT, schema: { amount: 'amount' }, instruction: 'read the invoice total' });
  const keys = Object.keys(out);
  if (keys.length === 1 && keys[0] === 'amount' && out['amount'] === '4.2') {
    console.log(`EXTRACT SMOKE ok amount=4.2 model=${loadModelsConfig().quarantine}`);
  } else {
    // the result is typed or null, never free text; an empty reply from a reasoning model reads as amount=null
    console.log(`EXTRACT SMOKE bad amount=${JSON.stringify(out['amount'] ?? null)}`);
    process.exit(1);
  }
} catch (e) {
  console.log(`EXTRACT SMOKE error ${e instanceof Error ? e.name : 'unknown'}`);
  process.exit(1);
}

// AIR-222: proof that the assume-compromise counters can fail. The raw source runs against a gate that allows everything and applies it to
// the SimWorld, and the same line is printed. It exits 1 by design.
import { formatLine, makeHarness, runRaw, summarize } from '../assume-compromise/index.ts';
import { BrokenBackend } from '../../test/helpers/broken.ts';

const h = makeHarness('A2', new BrokenBackend());
await runRaw(h);
const s = summarize(h);
console.log(formatLine('A2', s));
process.exitCode = s.value_to_nonbook > 0 || s.violations > 0 ? 1 : 0;

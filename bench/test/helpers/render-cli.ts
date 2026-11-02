// AIR-228 test helper: prints the generated block of the worked fixture. `bad` appends the clock, so the byte test can fail.
import { renderBlock } from '../../src/report/render.ts';
import { fixtureRuns, resultsOf } from './runs.ts';

const block = renderBlock(resultsOf(fixtureRuns()));
process.stdout.write(process.argv[2] === 'bad' ? block + new Date().toString() : block);

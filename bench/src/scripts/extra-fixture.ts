// Prints the 8 lines of the AIR-288 worked fixture (bench/test/fixtures/extra-expected.txt) from the hand-built section.
import { renderExtra } from '../report/extra.ts';
import { extraFixture } from '../../test/helpers/extra.ts';

process.stdout.write(renderExtra(extraFixture().extra) + '\n');

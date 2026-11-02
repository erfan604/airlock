// A stand-in for verdict_cli, for the backend tests. Mode `exit` answers the first line (the reset) and exits on the second without a
// reply; mode `silent` never answers. Node runs it: `new VerdictCliBackend({ cli: process.execPath, args: [thisFile, mode] })`.
import { createInterface } from 'node:readline';

const mode = process.argv[2];
let lines = 0;
createInterface({ input: process.stdin }).on('line', () => {
  lines += 1;
  if (mode === 'silent') return;
  if (lines === 1) {
    process.stdout.write('{"ok":true}\n');
    return;
  }
  process.exit(0);
});

# Claims and how to check each one

| # | Claim | Evidence (file:line) | Command | Expected output | Needs | Source ticket |
| --- | --- | --- | --- | --- | --- | --- |
| C1a | The sample gate cannot pay a recipient the owner did not name. | src/a.rs:3 (`pub fn gate`) | `scripts/sample-check.sh` | `SAMPLE OK` | none | AIR-030 |
| C2 | The sample bench reports n with every figure. | src/a.rs:40 | `scripts/bench-replay-check.sh` | `BENCH REPLAY OK` | none | AIR-228 |

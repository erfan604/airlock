# Claims and how to check each one

| # | Claim | Evidence (file:line) | Command | Expected output | Needs | Source ticket |
| --- | --- | --- | --- | --- | --- | --- |
| C1a | The sample gate cannot pay a recipient the owner did not name. | src/gate.rs:10 | `scripts/sample-check.sh` | `SAMPLE OK` | none | AIR-030 |
| C2 | The sample bench reports n with every figure. | bench/results/final.json:1 | `pending: AIR-228 scripts/bench-replay-check.sh` | `BENCH REPLAY OK` | none | AIR-228 |

# Claims and how to check each one

| # | Claim | Evidence (file:line) | Command | Expected output | Needs | Source ticket |
| --- | --- | --- | --- | --- | --- | --- |
| C1a | The fixture gate refuses a recipient the owner did not name. | src/gate.rs:10 | `scripts/sample-check.sh` | `SAMPLE OK` | none | AIR-030 |

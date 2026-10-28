# Third-party code

Code copied or adapted into this repository (libraries installed through the lockfile are listed there, not here). Each row
matches a `// adapted from` comment in the source. Allowed licenses: MIT, Apache-2.0, BSD-2/3-Clause, ISC.

| Our file | Source repo | Commit or tag | Source path | License | What changed |
| --- | --- | --- | --- | --- | --- |
| contracts/airlock-policy (fork) | Shade Agent template (upstream named in the research repo plan/reuse/REUSE_near.md) | recorded by AIR-040 when forking | whole crate | upstream LICENSE, copied to the crate | request_signature, update and migrate methods deleted; gate, ledgers, escalations added |

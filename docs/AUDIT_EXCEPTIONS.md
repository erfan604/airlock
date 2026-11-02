# Audit exceptions

`scripts/audit-check.sh` runs `pnpm audit --prod --audit-level=high` and passes when it exits 0 or when every advisory it lists is a row below.
A row is `| advisory id | package | reason | date |`. The advisory id is the GHSA id or the numeric id the audit prints.

| id | package | reason | date |
| --- | --- | --- | --- |

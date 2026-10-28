# Benchmark

## Method
Sample method text for the video script checker fixture.

## Results
<!-- BEGIN GENERATED -->
model fixture-model, quarantine fixture-small, n 10, hooks product, runs 70
V1 status DONE 10 NO_PLAN 0 NO_TASK 0 ERROR 0
V1-tight status DONE 10 NO_PLAN 0 NO_TASK 0 ERROR 0

Attack groups

| Config | Group | Runs | Utility under attack | Attack success, auto | Attack success, oracle approver | Attack success, naive approver | Escalation precision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | ALL | 10 | 5/10 (50.0%, 23.7 to 76.3) | 6/10 (60.0%, 31.3 to 83.2) | 6/10 (60.0%, 31.3 to 83.2) | 8/10 (80.0%, 49.0 to 94.3) | 2/5 (40.0%, 11.8 to 76.9) |
| V1-tight | ALL | 10 | 4/10 (40.0%, 16.8 to 68.7) | 2/10 (20.0%, 5.7 to 51.0) | 2/10 (20.0%, 5.7 to 51.0) | 3/10 (30.0%, 10.8 to 60.3) | 1/4 (25.0%, 4.6 to 69.9) |

Benign tasks

| Config | Runs | Benign utility | Assisted utility, oracle approver | EP100 | Runs with an escalation | Mean cost per run USD | Mean latency ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | 10 | 9/10 (90.0%, 59.6 to 98.2) | 9/10 (90.0%, 59.6 to 98.2) | 0.00 | 0/10 (0.0%, 0.0 to 27.8) | 0.001 | 100 |
| V1-tight | 10 | 6/10 (60.0%, 31.3 to 83.2) | 6/10 (60.0%, 31.3 to 83.2) | 0.00 | 0/10 (0.0%, 0.0 to 27.8) | 0.001 | 100 |
<!-- END GENERATED -->

## Limits
The V1 limit is 50 NEAR and the V1-tight limit is 5 NEAR.

## Reproduce
Run the replay command.

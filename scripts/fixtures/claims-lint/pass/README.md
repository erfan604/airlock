# Sample project

A sample wallet gate that never pays a recipient the owner did not name [C1a].

Run `pnpm demo` to replay a recorded run. See docs/CLAIMS.md for the list of claims.

## The problem

Agents that read untrusted text have lost money, and the Grok and Bankr loss was reported at $150K to $204K, depending on the source [S1].
Four multisig approval failures since July 2024 cost about $2.0 billion, with the Bybit and Radiant pair at about $1.5 billion [S2].
No wallet we surveyed, listed in docs/PRIOR_ART.md, checks where a recipient came from [PA1].

## Try it in 2 minutes

```sh
pnpm demo --no-open --exit-when-ready
# ready in 2 seconds
```

## What is enforced where

| Guarantee | Enforced by | Claim |
| --- | --- | --- |
| No payment to an unnamed recipient | The contract will refuse it | [C1a] |
| Labels follow each value | The runtime tracks them | [C1a] |

## Claims

- The gate cannot pay an unnamed recipient [C1a].
- The bench never reports a number without its sample size [C2].

<!-- bench:start -->
<!-- bench:end -->
`pnpm bench:replay`

## Prior art

Interbolt (`deconvolute-labs/interbolt`) reports an AgentDojo banking attack success of 0 of 144 under its own policy [PA4]. Microsoft FIDES ships in `microsoft/agent-framework` [PA3]. The sample adds pc taint, amount provenance and enforcement at the signer.

## Limits

See `docs/KNOWN_LIMITATIONS.md`.

# NEAR Intents 1Click quote leg (AIR-305)

After the verdict has Allowed a payment, the runtime can route a cross-chain payout through NEAR Intents 1Click. It asks for a `dry: true` quote
and `runtime/src/chain/intents.ts` compares the quote with the allowed payment. The module imports no signer, chain client or key: a pass records
the quote, a refusal names a reason, and neither signs.

Labelled dry: Intents has no testnet (hackathon rules Q-007), so a quote carries mainnet prices and no funds ever move. A dry quote has no deposit
address at all (1Click docs), so the deposit binding below is exercised by a recorded live-shape fixture only.

## Checks and reasons

| Reason | Refused when |
| --- | --- |
| MalformedQuote | the answer is not the documented shape, an amount is not a decimal string, or the call failed |
| NotDry | the request or the echoed request is not dry |
| RequestEchoMismatch | the echoed request differs from the body we sent |
| RecipientMismatch, RecipientNotOnDestinationChain | the recipient is not the allowed payee on the destination chain |
| DestinationAssetMismatch, OriginAssetMismatch | an asset differs from the allowed one |
| AmountOutBelowAllowed | amountOut or minAmountOut is below the allowed amount |
| AmountInAboveCap | the cost in the origin asset is above the Allow's cap |
| SlippageTooWide | the requested slippage or the quote's own spread exceeds the bound in basis points |
| RefundNotOurs | the refund address is not in our set, or is not on the origin chain |
| DeadlineOutsideWindow | the deadline is outside the authorization window |
| UnexpectedFee | the echoed request names a fee recipient that is not on the allowed list, or a fee above that recipient's bound in basis points (1Click adds its own fee recipient to unauthenticated quotes; it is pinned) |
| RequestEchoMismatch | also: a key of the echoed request that was neither sent nor a known server default, or a fee entry with an unknown key |
| UnexpectedDepositAddress, MissingDepositAddress | a dry quote carries a deposit address, or a non-dry one has none |

A pass returns a record with the allowed request id, the deposit address (null for a dry quote) and a SHA-256 binding over request id, deposit address,
payee, destination asset, amounts and the 1Click correlation id. Reasons are fixed strings and never repeat a value the server sent.

## Run it

`pnpm demo:intents` checks the recorded live dry quote offline (`runtime/test/fixtures/intents/dry-exact-output.live.json`, recorded 2026-11-03).
`pnpm demo:intents --live` asks 1Click for a fresh dry quote (no key needed; `ONE_CLICK_API_KEY` is read from the environment if set).
Tests: `pnpm -C runtime exec tsx --test test/intents.test.ts`.

## Limits

- The 1Click quote signature (an ed25519 signature over a hash of the payload) is not verified here; the public key is not in the pages we read. The echo check and the comparisons
  stand in for it.
- No non-dry quote is ever requested, so no deposit address has been seen live and nothing was paid; the binding is tested on a fixture derived from the live one.
- The pass does not make a payment: signing the payout on the origin chain is not wired to this leg.

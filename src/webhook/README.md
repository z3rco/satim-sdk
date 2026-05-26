# webhook

Zero-trust callback handler for SATIM gateway notifications.

## Responsibility

Receive a callback or redirect from SATIM and produce a server-verified `ConfirmResponse`. The callback payload is never trusted — every invocation triggers a server-to-server `satim.confirm()` against the real gateway, with automatic amount verification.

This is strictly stronger than HMAC signature verification: a valid signature proves the payload was issued by the gateway, but does not prove the payload reflects current state. Re-fetching live state defeats both replay attacks and stale-webhook races.

## Files

| File | Responsibility |
|------|----------------|
| [`rate-limiter.ts`](./rate-limiter.ts) | `SlidingWindowRateLimiter`. Binary-search expiry pruning with a head pointer; periodic array compaction. `check()` is amortised `O(log n)` per call. |
| [`extract.ts`](./extract.ts) | `extractOrderId`. Multi-source extraction from string, URL, Web `Request`, or plain object with `orderId`. Returns `null` for anything that fails the strict `[a-zA-Z0-9\-]{1,128}` format. |
| [`handler.ts`](./handler.ts) | `WebhookHandler`. The public class. Orchestrates extraction, rate limit, in-flight lock, duplicate check, `confirm()`, and mark-processed. |

## Dependencies

| External (within `src/`) | Used for |
|--------------------------|----------|
| `../Satim` (type only) | The handler holds a reference to the `Satim` instance for server-to-server verification. |
| `../responses/confirm` (type only) | `ConfirmResponse` appears in `WebhookResult`. |
| `../exceptions` | `SatimInvalidArgumentError`, `SatimMissingDataError` for construction-time validation. |

## Verification flow

`handler.verify(source)`:

1. **Extract** orderId via `extract.ts`. Invalid → return `null`.
2. **Rate limit** via the sliding window. Exceeded → return `null`.
3. **In-flight lock**. If another `verify()` is already running for this `orderId`, await it and return `{ duplicate: true, response: <its response> }`. Otherwise acquire the lock for the duration of this call.
4. **Duplicate check** via `onCheckDuplicate(orderId)`. If true, still call `onResolveAmount` and `satim.confirm()` so the caller receives the same verified response, but flagged `duplicate: true`.
5. **Resolve expected amount** via `onResolveAmount(orderId)`. Unknown order → return `null` (do not call the gateway for orders the merchant does not recognise).
6. **Server-to-server verification**: `satim.confirm(orderId, expectedAmount)`. `confirm` runs `verifyAmount()` automatically on success.
7. **Mark processed** via `onMarkProcessed(orderId)` only if the response is **not** `isPending()`. Pending orders are intentionally not marked so subsequent callbacks can re-check as the order progresses to a terminal state.
8. Release the in-flight lock in `finally`.

## Distributed deployment

The in-process duplicate set (`processedSet`) and the in-flight lock (`inflightLocks`) are per-process. Multi-instance deployments (Kubernetes pods, multiple dynos, serverless cold starts) must:

- Provide `onCheckDuplicate` and `onMarkProcessed` backed by a shared store.
- Implement the check and the mark as a **single atomic operation** in `onCheckDuplicate` (Redis `SETNX`, database `INSERT ... ON CONFLICT DO NOTHING`). The handler calls them separately, but cross-instance correctness requires the atomic step to live inside `onCheckDuplicate`.

The handler emits a `console.warn` at construction time when neither callback is provided. Set `suppressMultiInstanceWarning: true` only after confirming single-process deployment.

## Rate limiter behaviour

`SlidingWindowRateLimiter(maxRequests, windowMs)`:

- `check()` returns `true` if the request is admitted, `false` if the window is full.
- Timestamps are stored in a sorted array. Binary search advances a `head` pointer past expired entries on each call.
- When `head > 1000`, the array is sliced to reclaim memory. Amortised allocation cost is `O(1)` per call.
- Complexity: `O(log n)` per `check()` where `n` is the number of unexpired timestamps.

Defaults exposed via `WebhookHandlerOptions`: `maxCallbacksPerWindow = 100`, `rateLimitWindowMs = 60_000`.

## Impact of changes

| Editing | Potentially affects |
|---------|---------------------|
| `rate-limiter.ts` | Throughput cap for callback delivery. Changing the algorithm may break the amortised-`O(1)` allocation guarantee. |
| `extract.ts` | The accepted input surface. Loosening the orderId regex may accept malicious values that the SDK's downstream validators do not catch. |
| `handler.ts` step order | The check-then-mark race window. Re-ordering steps 3–7 risks double-fulfillment. |
| `handler.ts` pending-skip behaviour | Whether pending orders are marked. Marking pending orders would prevent re-checking and could leave merchants unaware of eventual settlement. |

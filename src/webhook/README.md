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
| [`handler.ts`](./handler.ts) | `WebhookHandler`. The public class. Orchestrates extraction, rate limit, in-flight lock, duplicate check, gateway verification, and mark-processed. Exposes `verify()` (`WebhookResult \| null`) and `inspect()` (a `WebhookOutcome` carrying the rejection reason). |

## Dependencies

| External (within `src/`) | Used for |
|--------------------------|----------|
| `../Satim` (type only) | The handler holds a reference to the `Satim` instance for server-to-server verification. |
| `../responses/confirm` (type only) | `ConfirmResponse` appears in `WebhookResult`. |
| `../exceptions` | `SatimInvalidArgumentError`, `SatimMissingDataError` for construction-time validation. |

## Verification flow

`handler.verify(source)`:

1. **Extract** orderId via `extract.ts`. Invalid → `invalid_source`.
2. **Rate limit** via the sliding window. Exceeded → `rate_limited`. Answer this with `429`/5xx so SATIM redelivers; answering `200` silently discards a real payment notification.
3. **In-flight lock**. If another verification is already running for this `orderId`, await it and return `{ duplicate: true, response: <its response> }`. Otherwise acquire the lock for the duration of this call.
4. **Duplicate check and expected amount** via `onCheckDuplicate(orderId)` and `onResolveAmount(orderId)`, run in parallel — independent lookups. Unknown order (nullish amount) → `unknown_order`, without calling the gateway.
5. **Server-to-server verification**. First-time callbacks call `satim.confirm(orderId, expectedAmount)`, which runs `verifyAmount()` automatically on success. Already-processed orders call `satim.status(orderId)` instead: both return authoritative live state, but `/public/acknowledgeTransaction.do` is a mutating acknowledgement that replays should not re-fire, and `status()` is idempotent so it retries and de-duplicates. The replay path re-asserts the amount explicitly.
6. **Mark processed** via `onMarkProcessed(orderId)` only once the order reaches a terminal `OrderStatus` — deposited (`"2"`), refunded (`"4"`), or reversed (`"3"`).
7. Release the in-flight lock in `finally`.

### Why marking is terminal-only

Marking is one-way: every later callback for a marked order comes back `duplicate: true`, which callers are told not to fulfil. So the test must be "definitely finished", not "not pending":

- **Pre-authorized** (`"1"`) is a fund hold awaiting capture. Marking it means the capture callback arrives as a duplicate and the order is never fulfilled.
- **Declined, cancelled and expired** responses carry no `OrderStatus` at all. A customer who retries their card on the same order and succeeds would otherwise be charged without being fulfilled.

The cost of leaving them unmarked is at most a repeated `status()` read.

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

The window is **per handler instance and global across orders**, so size it against peak checkout throughput rather than per-customer traffic. Well-formed callbacks for unknown orders consume budget too (the order is only known to be unknown after `onResolveAmount` runs), so a public callback endpoint should sit behind the same edge rate limiting as the rest of the application. Malformed sources are rejected before the limiter and cost nothing.

## Impact of changes

| Editing | Potentially affects |
|---------|---------------------|
| `rate-limiter.ts` | Throughput cap for callback delivery. Changing the algorithm may break the amortised-`O(1)` allocation guarantee. |
| `extract.ts` | The accepted input surface. Loosening the orderId regex may accept malicious values that the SDK's downstream validators do not catch. |
| `handler.ts` step order | The check-then-mark race window. Re-ordering steps 3–7 risks double-fulfillment. |
| `handler.ts` pending-skip behaviour | Whether pending orders are marked. Marking pending orders would prevent re-checking and could leave merchants unaware of eventual settlement. |

# webhook

Zero trust callback handler for SATIM gateway notifications.

## Responsibility

Turn an untrusted callback into a server verified `ConfirmResponse`. The payload is used
only to learn which order to re-read; every invocation fetches live state from the gateway
with automatic amount verification.

Signature and re-fetch answer different questions and the handler does both.
`callbackSecret` enables HMAC-SHA256 `checksum` verification, which proves the
notification came from the gateway. Re-fetching proves it still reflects reality, which a
replayed but validly signed notification does not.

## Files

| File | Responsibility |
| - | - |
| [`rate-limiter.ts`](./rate-limiter.ts) | `SlidingWindowRateLimiter`. Sorted timestamp array, binary search expiry with a head pointer, compaction when `head > 1000`. `check()` is O(log n) with amortised O(1) allocation |
| [`extract.ts`](./extract.ts) | `extractOrderId`, `extractParams`. Multi source extraction from a string, URL, Web `Request`, or plain object. `strictQueryParams` rejects any URL carrying duplicate query keys |
| [`checksum.ts`](./checksum.ts) | `buildSignedString`, `verifyCallbackChecksum`. In tree HMAC-SHA256 over raw bytes, constant time hex comparison |
| [`handler.ts`](./handler.ts) | `WebhookHandler`. Orchestrates extraction, signature, rate limit, in flight lock, duplicate check, gateway verification, terminal marking. Exposes `verify()` and `inspect()` |

## Internal dependencies

| Import | Used for |
| - | - |
| `../Satim` (type only) | the handler holds the client for server to server verification |
| `../responses/confirm` (type only) | `ConfirmResponse` in `WebhookResult` |
| `../exceptions` | `SatimMissingDataError`, `SatimInvalidArgumentError` at construction |
| `../crypto` | `sha256Bytes` for the HMAC |

Type only imports keep the `Satim -> handler -> Satim` cycle out of the runtime graph.

## Callback shape

Notifications arrive as query parameters on `dynamicCallbackUrl`, for example
`?mdOrder=...&orderNumber=...&operation=deposited&status=1`. The order key is `mdOrder`,
not `orderId`; `extractOrderId` accepts both, `orderId` first. Accepted format is
`^[a-zA-Z0-9-]{1,128}$` after trimming.

## Verification flow

`inspect(source)` returns `{verified: true, result}` or `{verified: false, reason}`.
`verify(source)` collapses every rejection to `null`, which loses the reason.

| Step | Action | Rejection |
| - | - | - |
| 1 | Extract the order id. Reject duplicate query keys and any value failing the format | `invalid_source` |
| 2 | If `callbackSecret` is set, recompute the HMAC and compare in constant time. If unset and the callback carries `checksum`, warn once and continue | `bad_signature` |
| 3 | Sliding window rate limit, after the signature check so forged traffic cannot exhaust the window | `rate_limited` |
| 4 | Per order in flight lock. A concurrent call awaits the first and returns its response with `duplicate: true` | |
| 5 | `onCheckDuplicate(orderId)` and `onResolveAmount(orderId)` in parallel. A nullish amount means unknown, and no gateway call is made | `unknown_order` |
| 6 | First delivery: `satim.confirm(orderId, expectedAmount)`, which verifies the amount on success. Replay: `satim.status(orderId)` plus an explicit `verifyAmount` | |
| 7 | `onMarkProcessed(orderId)` only on a first delivery that reached a terminal `OrderStatus` | |
| 8 | Release the lock in `finally` | |

Step 6 splits deliberately: `/public/acknowledgeTransaction.do` is a mutating
acknowledgement that a replay must not re-fire, while `/getOrderStatus.do` is idempotent
and retryable.

### Signed string

All parameters except `checksum` and `sign_alias`, sorted by name, rendered `name;value;`
and concatenated. HMAC-SHA256 with the bank shared secret, hex, compared case
insensitively in constant time. `sha256Bytes` is used rather than `sha256Hex` because HMAC
blocks are raw bytes and UTF-8 encoding them would corrupt anything above `0x7F`.

### Terminal state marking

Marked states: captured (`OrderStatus` 2), refunded (4), reversed (3). Everything else
stays unmarked.

Marking is one way: every later callback for a marked order returns `duplicate: true`,
which callers are told not to fulfil. So the test is "definitely finished", not "not pending".

- Pre-authorized (1) is a fund hold awaiting capture. Marking it makes the capture callback
  arrive as a duplicate and the order is never fulfilled.
- Declined, cancelled and expired responses carry no `OrderStatus`. A customer who retries
  their card on the same order and succeeds would be charged without being fulfilled.

Cost of leaving a state unmarked: one extra `status()` read per redelivery.

## Options

| Option | Default | Constraint |
| - | - | - |
| `onResolveAmount` | required | returns expected major units, or nullish for an unknown order |
| `callbackSecret` | none | required unless `allowUnverifiedCallbacks` is true |
| `allowUnverifiedCallbacks` | `false` | required unless `callbackSecret` is set. Neither option set throws `SatimMissingDataError` |
| `onCheckDuplicate` | in process `Set` lookup | must be atomic with the mark step across instances |
| `onMarkProcessed` | in process `Set` insert, FIFO bounded at 10000 | |
| `maxCallbacksPerWindow` | 100 | integer >= 1 |
| `rateLimitWindowMs` | 60000 | integer >= 1000 |
| `suppressMultiInstanceWarning` | `false` | silences the in memory fallback warning |

## Rate limiter behaviour

- `check()` returns `true` if admitted, `false` if the window is full.
- Timestamps are stored sorted. Binary search advances a `head` pointer past expired
  entries on each call; the array is sliced when `head > 1000`.
- Complexity O(log n) per call, where n is the number of unexpired timestamps.
- The window is per handler instance and global across orders. Size it against peak
  checkout throughput, not per customer traffic.
- Well formed callbacks for unknown orders consume budget: the order is only known to be
  unknown after `onResolveAmount` runs. A public callback endpoint should sit behind the
  same edge rate limiting as the rest of the application.
- Malformed sources are rejected before the limiter and cost nothing.
- Answer `rate_limited` with 429 or a 5xx so SATIM redelivers. Answering 200 silently
  discards a real payment notification.

## Distributed deployment

`processedSet` and `inflightLocks` are per process. Multi instance deployments must:

1. Provide `onCheckDuplicate` and `onMarkProcessed` backed by a shared store.
2. Implement check and mark as one atomic operation inside `onCheckDuplicate`
   (Redis `SETNX`, database `INSERT ... ON CONFLICT DO NOTHING`). The handler calls them
   separately; cross instance correctness requires the atomic step to live in the check.

The handler emits a `console.warn` at construction when neither callback is provided.

## Blast radius

| Editing | Affects |
| - | - |
| `rate-limiter.ts` | callback throughput cap. Changing the algorithm may break the amortised O(1) allocation guarantee |
| `extract.ts` | the accepted input surface. Loosening the order id pattern or the duplicate key rejection re-opens the parser differential replay |
| `checksum.ts` | callback origin verification. Any change to the signed string or the digest breaks compatibility with the bank shared secret |
| `handler.ts` step order | the check then mark race window. Re-ordering steps 4 to 8 risks double fulfilment |
| `handler.ts` terminal set | whether paid orders are fulfilled. Widening it reports later real callbacks as duplicates |

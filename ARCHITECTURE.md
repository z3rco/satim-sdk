# Architecture

Internal design of the SATIM SDK. For usage, see the root [README](./README.md).

## System topology

Twenty-one TypeScript files organised by concern. Dependency direction is strict: lower layers never import from higher ones.

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Primitives | `exceptions.ts`, `types.ts` | Exception hierarchy, public type definitions. No internal deps. |
| Math | `money.ts`, `crypto.ts`, `idempotency.ts` | IEEE-754-safe currency conversion, runtime-agnostic SHA-256/CSPRNG, deterministic key derivation. |
| Validation | `validation.ts`, `ssrf.ts` | Pure validators for fluent setters and URL safety. |
| Configuration | `config.ts` | `SatimConfig` base class. Holds credentials in a module-private `WeakMap` and provides the immutable fluent setter API. |
| Transport | `client.ts`, `circuit-breaker.ts` | HTTP POST against the SATIM REST API, retry policy, circuit breaker. |
| Responses | `responses/schema.ts`, `responses/register.ts`, `responses/confirm.ts` | Boundary schema validation and typed wrappers for gateway responses. |
| Webhook | `webhook/rate-limiter.ts`, `webhook/extract.ts`, `webhook/handler.ts` | Zero-trust callback handler. |
| Facade | `Satim.ts` | Public client. Extends `SatimConfig`, owns the HTTP client instance, exposes the endpoint methods. |
| Compatibility | `utils.ts`, `responses.ts`, `webhook.ts` | Re-export shims preserving legacy import paths from before the directory split. |

## Request lifecycle

A `register()` call traverses every layer once:

1. Caller chains fluent setters on `Satim`. Each setter clones the config, mutates the clone, returns it. The original is never modified.
2. `register()` calls `validateForRegister` (asserts `returnUrl` and `amount` are set), then `getFinalOrderNumber` (uses the configured order number or generates a random 10-character base-36 one from `crypto.getRandomValues`).
3. `buildData` assembles the form payload. It strips `force_terminal_id` from user-defined fields and always sets it from the credential store — user input cannot override the terminal binding.
4. `httpClientService.handleApiRequest` runs the request. Retries are enabled iff an `externalRequestId` (idempotency key) is set.
5. `assertTlsSafe` aborts if `NODE_TLS_REJECT_UNAUTHORIZED=0` is in the environment. This runs before the breaker gate so a configuration fault never consumes a `HALF_OPEN` probe.
6. The circuit breaker is consulted. If `OPEN` and the reset timeout has not elapsed, the call throws `SatimUnexpectedResponseError` with `errorCategory: "circuit_open"`.
7. `fetch` POSTs `application/x-www-form-urlencoded`. Anti-caching headers are set on every request because POST bodies carry credentials.
8. On any transient failure — 5xx, timeout, connection failure, malformed payload — the breaker records a failure. Retryable ones (everything but malformed payloads) go round the loop again with exponential backoff (`500ms × 2^attempt`, plus 0–50% jitter).
9. The response body is parsed. `validateApiResponse` maps `ErrorCode` to typed exceptions (see [Error classification](#error-classification)).
10. The JSON is passed to `new RegisterResponse(raw)`. Its constructor runs `validateRegisterSchema` and then `structuredClone`s the payload into the instance.

`confirm()`, `status()`, `refund()`, and `reverseOrder()` follow the same path but wrap the result in `ConfirmResponse`. `confirm()` additionally calls `verifyAmount()` automatically when the response satisfies `isSuccessful()`.

## Technical constraints

### IEEE-754 currency conversion

The gateway sends and receives amounts in minor units (centimes). All arithmetic uses `Number`, which is IEEE-754 double precision. Two design constraints fall out:

- `toMinorUnits(amount)` rejects sub-centime precision before rounding. The check is a relative-epsilon comparison: `|amount*100 - round(amount*100)| > max(1e-7, |round(amount*100)| × 1e-13)`. The relative term keeps the check sound up to `MAX_SAFE_AMOUNT`; the floor avoids false positives on artifacts like `0.1 + 0.2 → 0.30000000000000004`. A prior implementation used `toPrecision(12)` which silently rounded the 13th significant digit and missed sub-centime offsets near the cap.
- `MAX_SAFE_AMOUNT = 9_999_999_999.99`. Above this the relative-epsilon check loses fidelity. Inputs are rejected outright above this threshold.

Reverse conversion (`getAmount()`, `getDepositAmount()`) divides the gateway integer by 100 and applies `toFixed(2)` to canonicalise the decimal representation. Values above `Number.MAX_SAFE_INTEGER` return `undefined` rather than silently losing precision.

Complexity: all currency operations are `O(1)`.

### Credential isolation

Credentials are stored in a module-private `WeakMap<SatimConfig, Creds>` declared inside `config.ts`. The mapping is unreachable from outside the module — there is no exported accessor. Consequences:

- `Object.keys(satim)`, `Reflect.ownKeys(satim)`, `JSON.stringify(satim)`, and prototype traversal never expose credentials.
- `toJSON()`, `Symbol.for("nodejs.util.inspect.custom")`, and `Symbol.toPrimitive` all return `[REDACTED]` placeholders for the credential fields.
- The `clone()` method copies credentials from one `WeakMap` entry to another. The clone is a peer in the same map, not a holder of duplicated fields.

The SATIM API requires credentials in the POST body of every request. The SDK cannot eliminate that exposure; it can only ensure the credentials never leak from the SDK's own surface. Reverse proxies, WAFs, and APM tools that log request bodies remain a real risk and are documented in [SECURITY.md](./SECURITY.md).

### SSRF protection

`assertSafeUrl` runs on every URL setter (`returnUrl`, `failUrl`, `dynamicCallbackUrl`). Rejection rules:

| Class | Examples |
|-------|----------|
| Scheme | Anything other than `http:` or `https:`. |
| Hostnames | `localhost`, `[::1]`, `metadata.google.internal`. |
| Private IPv4 | `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `0/8`. |
| Private IPv6 | Loopback, ULA (`fc00::/7`), link-local (`fe80::/10`), IPv4-mapped and IPv4-translated variants, NAT64 (`64:ff9b::/96`), unspecified. |
| Non-standard encoding | Decimal (`2130706433`), octal (`0177.0.0.1`), hex (`0x7f.0.0.1`). |

Validated URLs are cached in a bounded `Set` (max 512) to amortise the cost across hot paths. The cache evicts the oldest entry on overflow.

**Known limitation:** validation occurs at configuration time only. The SDK does not re-resolve DNS at request time, so a host that resolved to a public IP during validation could later resolve to a private IP via DNS rebinding. The SDK itself does not fetch these URLs — they are forwarded to SATIM for callback delivery — so the risk transfers to the callback endpoint operator.

### Circuit breaker

States: `CLOSED` → `OPEN` → `HALF_OPEN` → `CLOSED`.

| Transition | Trigger |
|------------|---------|
| `CLOSED → OPEN` | `failureThreshold` consecutive transient failures. Default 5. |
| `OPEN → HALF_OPEN` | `resetTimeoutMs` elapses since opening. Default 30 000 ms. Lazy: the transition fires the next time `allowRequest()` is called. |
| `HALF_OPEN → CLOSED` | Probe request succeeds. |
| `HALF_OPEN → OPEN` | Probe request fails. Reset timer starts over. |
| `HALF_OPEN → HALF_OPEN` | Probe unreported for `resetTimeoutMs`: treated as abandoned, a fresh probe is admitted. |

A transient failure is a timeout, a connection-level failure (DNS, ECONNREFUSED, TLS), a 5xx response, or a malformed/non-object payload. A 4xx is not: it means the SDK sent something the gateway disliked, which waiting cannot fix. The `NODE_TLS_REJECT_UNAUTHORIZED=0` guard is checked before the breaker gate, so a configuration fault neither counts as a failure nor consumes the single `HALF_OPEN` probe.

In `HALF_OPEN`, at most one probe request is admitted concurrently. `allowRequest()` checks `probeInFlight` and rejects extra calls until the probe resolves. This prevents a recovering gateway from being hit by a thundering herd.

The single-probe rule needs the accounting invariant below to hold, and needs a backstop for when it does not. `probeInFlight` is cleared only by `onSuccess()`/`onFailure()`, so a probe whose outcome is never reported would otherwise leave the breaker rejecting every request for the life of the process, with no timer able to recover it. An unreported probe is therefore treated as abandoned after `resetTimeoutMs`.

`getState()` reflects a timed-out `OPEN` as `HALF_OPEN` for external inspection even before `allowRequest()` mutates the state.

### Retry policy

`handleApiRequest(endpoint, data, options)` accepts `options.retryable`. The defaults per endpoint:

| Endpoint | Retryable | Rationale |
|----------|-----------|-----------|
| `/register.do`, `/registerPreAuth.do` | Iff `_idempotencyKey` is set | Without an idempotency key, retrying after a timeout could create duplicate orders (`ErrorCode: 1`). With one, the gateway deduplicates. |
| `/getOrderStatus.do` (webhook replay path) | `true` | An already-processed order is re-read rather than re-acknowledged. |
| `/public/acknowledgeTransaction.do` (`confirm`) | `false` | Final-state query; retry would double-fire any merchant-side side effects derived from the response. |
| `/getOrderStatus.do` (`status`) | `true` | Idempotent read. |
| `/refund.do` | `false` | Mutation without idempotency primitive. |
| `/reverse.do` | `false` | Mutation without idempotency primitive. |

Backoff is exponential with 0–50% jitter: `BASE_RETRY_DELAY_MS × 2^attempt + uniform(0, 0.5 × base)`. Defaults: `BASE = 500ms`, `maxRetries = 2`. Maximum total backoff at defaults: ~2.25 seconds.

**Accounting invariant:** a `true` from `allowRequest()` must be answered by exactly one `onSuccess()`/`onFailure()`. Every attempt in `sendRequest` therefore funnels through a single `catch`, which normalises the error and makes one accounting decision. An exit path reporting neither would blind the breaker to that failure mode entirely, and would strand the breaker if the attempt happened to be the `HALF_OPEN` probe.

### Zero-trust webhook verification

SATIM does not sign callback payloads. The handler treats the payload as untrusted and re-fetches authoritative state:

1. Extract `orderId` from the source (string, URL, Web `Request`, or object). Reject anything that fails the strict `[a-zA-Z0-9\-]{1,128}` format.
2. Apply rate limit. If the sliding window is full, reject with `rate_limited`. `inspect()` surfaces that reason so the caller can answer `429` and have SATIM redeliver; `verify()` collapses it to `null`, which an unwary caller answers `200` — silently dropping a real payment notification.
3. Acquire the per-`orderId` in-flight lock. Concurrent calls for the same order wait on the first; the lock prevents the check-then-mark race within a single process.
4. Call `onCheckDuplicate(orderId)` and `onResolveAmount(orderId)` in parallel — independent lookups, typically both hitting the merchant's database. An unknown order (nullish amount) returns without touching the gateway.
5. Fetch authoritative state. A first-time callback uses `satim.confirm(orderId, expectedAmount)`, which runs `verifyAmount()` automatically on success. An already-processed order uses `satim.status(orderId)` instead — both return live state, but `/public/acknowledgeTransaction.do` is a mutating acknowledgement and replays must not re-fire it. The replay path re-asserts the amount explicitly.
6. If the response reached a **terminal** `OrderStatus` — deposited (`"2"`), refunded (`"4"`), reversed (`"3"`) — call `onMarkProcessed(orderId)`. Every other state stays unmarked.
7. Marking is one-way: later callbacks for a marked order return `duplicate: true`, which callers are told not to fulfil. So the test is "definitely finished", not "not pending". A pre-authorized hold (`"1"`) still has a capture to come, and a declined attempt (no `OrderStatus` at all) may still be followed by a successful card retry on the same order — marking either would leave a paid customer unfulfilled.

This model is strictly stronger than HMAC verification. A valid signature proves the payload was issued by the gateway; it does not prove the payload reflects current state. Replay and stale-webhook attacks pass signature checks but cannot pass live re-verification.

**Distributed deployments:** the in-process duplicate set is per-process. Multi-instance deployments must provide `onCheckDuplicate` and `onMarkProcessed` backed by a shared store with atomic check-and-mark semantics (Redis `SETNX`, database `INSERT … ON CONFLICT`). The SDK warns at construction time when the in-memory fallback is in use.

### Terminal ID injection

`buildData()` strips `force_terminal_id` from user-supplied `jsonParams` before re-injecting the credential-store value. The validator in `validation.ts:assertUserField` also rejects `force_terminal_id` (along with `__proto__`, `constructor`, `prototype`) at setter time. Both defences are kept — defence in depth — because the validator could be bypassed by a caller constructing the user-fields object directly without going through `userDefinedField`.

## State and data models

### Order status state machine

`OrderStatus` values are defined by the SATIM/BPC spec. Lifecycle:

```
register()                              ┌─ confirm() ──→ 2 (deposited) ──→ refund() ──→ 4 (refunded)
       │                                │
       └─→ 0 (registered, not paid) ────┤
                                        │
                                        └─ partial capture (preauth) ──→ 1 (preauth) ──→ reverse() ──→ 3 (reversed)
                                                                            │
                                                                            └── capture ──→ 2
```

The simulator (when present) and the real gateway emit `OrderStatus` values within `{0,1,2,3,4}` or omit the field entirely for terminal failures (decline, cancel, expire) that never produced a status transition.

### Predicate mutual-exclusivity contract

Defined in `src/responses/confirm.ts` and re-stated here as the canonical reference.

For any well-formed `ConfirmOrderResponse`, exactly one of the following nine predicates returns `true`:

| Group | Predicate | Condition |
|-------|-----------|-----------|
| Leaf | `isSuccessful` | `OrderStatus === "2"` |
| Leaf | `isPending` | `OrderStatus === "0"` |
| Leaf | `isReversed` | `OrderStatus === "3"` |
| Leaf | `isRefunded` | `OrderStatus === "4"` |
| Leaf | `isPreAuthorized` | `OrderStatus === "1"` |
| Composite | `isExpired` | All leaves false ∧ `actionCode === "-2007"` |
| Composite | `isCancelled` | All leaves false ∧ not expired ∧ error signal present ∧ (`actionCode === "10"` ∨ message includes "payment is cancelled") |
| Composite | `isRejected` | All leaves false ∧ not expired ∧ not cancelled ∧ error signal present ∧ (`actionCode ∈ {"2003","111"}` ∨ `respCode ∉ {"", "00"}` ∨ message includes "payment is declined") |
| Catch-all | `isFailed` | True iff all eight predicates above are false |

The dependency chain is acyclic. Composites call leaves; `isFailed` calls all eight predicates above it. No predicate calls `isFailed`. The `hasErrorSignal` helper centralises the "any of `ErrorCode != "0"/undefined`, `params`, or `actionCode` is present" check used by `isCancelled` and `isRejected`.

### Fluent configuration immutability

Every setter on `SatimConfig` (and on `Satim` by extension) calls `clone()`, mutates the clone, and returns it. The original instance is never modified. Two consequences:

- Concurrent callers can share a base `Satim` instance safely.
- Mistakenly returning the original instead of the clone would create a state leak. The `clone()` implementation uses `Object.create(Object.getPrototypeOf(this))` and assigns each field explicitly — not `Object.assign` — so subclasses (notably `Satim`) can override `clone()` to copy their own additional fields (`httpClientService`, `_hasCustomHttpClient`, `_httpClientOptions`) without risk of `Object.assign` copying internal state from the wrong source.

### Error classification

`ErrorCode` returned by the gateway maps to typed exceptions:

| `ErrorCode` | Exception | Catchable as |
|-------------|-----------|--------------|
| `0` | (no error) | — |
| `1` | `SatimGatewayError` | `errorCode === "1"` (duplicate order — used to detect idempotency conflicts in `safeRegister`) |
| `3` | `SatimGatewayError` | `errorCode === "3"` (unknown currency) |
| `4` | `SatimGatewayError` | `errorCode === "4"` (missing parameter) |
| `5` | `SatimInvalidCredentialsError` | — |
| `6` | `SatimInvalidArgumentError` | — |
| `7` | `SatimGatewayError` | `errorCode === "7"` (system error) |
| any other non-zero | `SatimUnexpectedResponseError` | `errorCategory: "gateway"` |

All exceptions extend `SatimError`. Gateway messages are sanitised (truncated to 200 characters, non-printable bytes stripped) before being placed in error messages.

`SatimUnexpectedResponseError` exposes only a safe `errorCategory` enum (`"network" | "timeout" | "parse" | "http" | "gateway" | "circuit_open" | "unknown"`). Raw error messages, stack traces, and system codes are not retained — error reporters cannot accidentally leak request URLs or form bodies via this class.

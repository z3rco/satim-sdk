# Architecture

Internal design of satim-sdk. Usage documentation is in [README.md](./README.md).
This document is normative for contributors: the invariants in section 4 are the ones
a change must not break.

## 1. Layering

22 TypeScript files under `src/`. Dependency direction is strict and acyclic: a layer
imports only from layers above it in this table.

| Layer | Files | Responsibility |
| - | - | - |
| 0 Primitives | `exceptions.ts`, `types.ts` | Exception hierarchy, public type definitions. No internal imports |
| 1 Math and crypto | `money.ts`, `crypto.ts`, `idempotency.ts` | IEEE-754 safe currency conversion, in tree SHA-256, CSPRNG, deterministic key derivation |
| 2 Validation | `validation.ts`, `ssrf.ts` | Pure field validators, URL safety |
| 3 Configuration | `config.ts` | `SatimConfig`: credential store, immutable fluent setters |
| 4 Transport | `client.ts`, `circuit-breaker.ts` | Form encoded POST, retry policy, failure isolation |
| 5 Responses | `responses/schema.ts`, `responses/register.ts`, `responses/confirm.ts` | Boundary schema validation, typed wrappers, status predicates |
| 6 Webhook | `webhook/rate-limiter.ts`, `webhook/checksum.ts`, `webhook/extract.ts`, `webhook/handler.ts` | Zero trust callback handling |
| 7 Facade | `Satim.ts` | Public client. Extends `SatimConfig`, owns the HTTP client, exposes endpoint methods |
| 8 Surface | `index.ts` | Public barrel |
| Shims | `utils.ts`, `responses.ts`, `webhook.ts` | Re-exports preserving pre split import paths. No logic |

Layer 6 imports `Satim` and `ConfirmResponse` as types only, so the cycle
`Satim -> handler -> Satim` never exists at runtime.

## 2. Request lifecycle

`register()` traverses every layer once.

1. Caller chains fluent setters. Each setter validates, clones the config, mutates the
   clone, returns it. The receiver is never modified.
2. `validateForRegister()` asserts `returnUrl` and `amount` are set, else `SatimMissingDataError`.
3. `getFinalOrderNumber()` returns the configured order number, or 10 random base36
   characters drawn from `crypto.getRandomValues` with rejection sampling at byte >= 252
   so `byte % 36` stays uniform.
4. `buildData()` assembles the form payload. It strips `force_terminal_id` from caller
   fields and sets it from the credential store. Amounts pass through `toMinorUnits`.
5. `handleApiRequest(endpoint, data, {retryable})`. `retryable` is true only when
   `externalRequestId` is set. Retryable calls are coalesced on
   `endpoint + ":" + sha256(form body)`; a non retryable call is never coalesced.
6. `assertTlsSafe()` throws if `NODE_TLS_REJECT_UNAUTHORIZED=0`. It runs before the
   breaker gate so a configuration fault never consumes a HALF_OPEN probe.
7. The circuit breaker is consulted. OPEN and inside the reset window throws
   `SatimUnexpectedResponseError` with `errorCategory: "circuit_open"`.
8. `fetch` POSTs `application/x-www-form-urlencoded` with
   `Cache-Control: no-store, no-cache` and `Pragma: no-cache`, under an `AbortController`
   armed at `timeoutMs`.
9. HTTP 401/403 becomes `SatimInvalidCredentialsError`. Other non 2xx becomes
   `errorCategory: "http"` carrying `httpStatus`.
10. The body is streamed with a 1 MiB cap, parsed as JSON, and rejected if it is not an object.
11. Failures funnel through one `catch`: normalise, report to the breaker if it counts as
    gateway degradation, retry if retryable and attempts remain, else throw.
12. `validateApiResponse()` maps `ErrorCode` to a typed exception (section 6).
13. `new RegisterResponse(raw)` runs `validateRegisterSchema` then `structuredClone`s the
    payload into the instance.

`confirm()`, `status()`, `statusExtended()`, `refund()`, `reverseOrder()`, `deposit()` and
`decline()` follow the same path and wrap the result in `ConfirmResponse`. `confirm()`
additionally runs `verifyAmount()` and a settled currency cross check when the response
satisfies `isSuccessful()`.

## 3. Endpoint matrix

| Method | Endpoint | Form fields beyond credentials and `language` | Retryable |
| - | - | - | - |
| `register` | `/register.do` | `orderNumber`, `amount`, `currency`, `returnUrl`, `failUrl`, `jsonParams`, optional `description`, `sessionTimeoutSecs`, `dynamicCallbackUrl`, `externalRequestId` | iff `externalRequestId` set |
| `registerPreAuth` | `/registerPreAuth.do` | same as `register` | iff `externalRequestId` set |
| `confirm` | `/public/acknowledgeTransaction.do` | `mdOrder` | no |
| `status` | `/getOrderStatus.do` | `orderId` | yes |
| `statusExtended` | `/getOrderStatusExtended.do` | `orderId` | yes |
| `deposit` | `/deposit.do` | `orderId`, `amount` (0 means full order), `currency` | no |
| `refund` | `/refund.do` | `orderId`, `amount`, `currency` | no |
| `reverseOrder` | `/reverse.do` | `orderId` | no |
| `decline` | `/decline.do` | `orderId`, `orderNumber` | no |
| `warmup` | `/getOrderStatus.do` | sentinel `orderId` | no, swallows all errors |

Rationale for the retry column: a mutation without an idempotency primitive must not be
replayed. A repeated capture takes the money twice; a repeated refund gives it back
twice; a repeated acknowledgement re-fires whatever the merchant derives from it. Reads
are idempotent and always retry. Registration retries only with `externalRequestId`,
because the gateway then deduplicates instead of answering `ErrorCode 1`.

## 4. Invariants

| ID | Invariant | Breaking it causes |
| - | - | - |
| A1 | Every `allowRequest()` that returns true is answered by exactly one `onSuccess()` or `onFailure()` | The breaker is blind to a failure mode, or strands a HALF_OPEN probe |
| A2 | Setters clone; the receiver is never mutated | Cross request state leak on a shared base instance |
| A3 | Credentials are reachable only through the module private `WeakMap` in `config.ts` | Credential disclosure through enumeration or serialization |
| A4 | `force_terminal_id` is set from the credential store after caller fields are spread | Terminal ID injection, payments routed to another terminal |
| A5 | Caller amounts reach the wire only through `toMinorUnits` | Silent rounding, wrong charge |
| A6 | Exactly one status predicate is true per well formed response | Ambiguous order state, double fulfilment or none |
| A7 | Mutating endpoints are never retried | Double charge, double refund |
| A8 | The webhook marks an order processed only on a terminal `OrderStatus` | Paid order reported as duplicate, never fulfilled |
| A9 | `assertTlsSafe()` runs before the breaker gate | A config fault opens the circuit and survives the fix |
| A10 | The hosted form URL is checked on every path that hands it out | Open redirect to an attacker domain |

## 5. Subsystems

### 5.1 Currency conversion

Gateway amounts are integer minor units. All arithmetic is IEEE-754 double precision.

- `toMinorUnits(amount)` rejects sub centime precision before rounding. The test is a
  relative epsilon comparison:
  `abs(amount*100 - round(amount*100)) > max(1e-7, abs(round(amount*100)) * 1e-13)`.
  The relative term stays sound up to `MAX_SAFE_AMOUNT`; the `1e-7` floor avoids false
  positives on artefacts such as `0.1 + 0.2 = 0.30000000000000004`.
- `MAX_SAFE_AMOUNT = 9999999999.99`. Above it the relative epsilon check loses fidelity,
  so inputs are rejected outright.
- A positive amount that rounds to 0 minor units is rejected rather than converted to nothing.
- Registration adds two SATIM rules on top: minimum 5000 minor units, and a multiple of
  100 minor units.
- Reverse conversion divides by 100 and canonicalises with `toFixed(2)`. Values above
  `Number.MAX_SAFE_INTEGER` return `undefined` rather than losing precision silently.
- Gateway amounts are accepted as `"5000"` or `"5000.00"`: BPC serialises integer minor
  units through a decimal formatter on some endpoints.

Complexity: O(1) for every currency operation.

### 5.2 Credential isolation

`WeakMap<SatimConfig, Creds>` declared inside `config.ts`, with no exported accessor.

- `Object.keys`, `Reflect.ownKeys`, `JSON.stringify` and prototype traversal expose nothing.
- `toJSON()`, `Symbol.for("nodejs.util.inspect.custom")` and `Symbol.toPrimitive` return
  `[REDACTED]` for the three credential fields.
- `clone()` copies the credential record into a new `WeakMap` entry. The clone is a peer
  in the same map, not a holder of duplicated instance fields.
- Re-initialisation is rejected: credentials cannot be swapped on a live instance.

The SATIM API requires credentials in the POST body of every request. The SDK cannot
remove that exposure, only keep the credentials off its own surface. Body logging in
reverse proxies, WAFs and APM agents remains a real risk; see [SECURITY.md](./SECURITY.md).

### 5.3 SSRF guard

`assertSafeUrl(url, prefix, allowPrivate)` runs on `returnUrl`, `failUrl` and
`dynamicCallbackUrl`. `isPrivateHost` is also used to decide whether a custom `baseUrl`
may be plain HTTP.

| Class | Rejected |
| - | - |
| Scheme | anything other than `http:` or `https:` |
| Hostname | `localhost`, `[::1]`, `metadata.google.internal`, each after lowercasing and stripping one trailing dot |
| IPv4 | `0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `100.64/10` CGNAT (includes `100.100.100.200`), `198.18/15`, `224/4` multicast, `240/4` reserved |
| IPv6 | loopback, unspecified, ULA `fc00::/7`, link local `fe80::/10`, IPv4 mapped and translated forms, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001:0::/32` |
| Encoding | decimal (`2130706433`), octal (`0177.0.0.1`), hex (`0x7f.0.0.1`) |

Accepted URLs are memoised in a module level `Set` bounded at 512 entries, evicting the
oldest on overflow. `allowPrivateUrls(true)` returns before the private range checks and
before the cache write, so a permitted private URL never poisons the shared cache, and
the encoding check still applies.

Known limitation: validation happens at configuration time. The SDK does not re-resolve
DNS at request time, so a host that resolved public during validation may resolve private
later (DNS rebinding). The SDK does not fetch these URLs; SATIM does. The residual risk
belongs to the callback endpoint operator and is mitigated by egress controls.

### 5.4 Circuit breaker

States: CLOSED, OPEN, HALF_OPEN.

| Transition | Trigger |
| - | - |
| CLOSED to OPEN | `failureThreshold` consecutive counted failures. Default 5 |
| OPEN to HALF_OPEN | `resetTimeoutMs` elapsed since opening. Default 30000 ms. Lazy: applied on the next `allowRequest()` |
| HALF_OPEN to CLOSED | probe succeeds |
| HALF_OPEN to OPEN | probe fails. Reset timer restarts |
| HALF_OPEN to HALF_OPEN | probe unreported for `resetTimeoutMs`, treated as abandoned, a fresh probe is admitted |

Counted as gateway degradation: timeouts, connection level failures (DNS, ECONNREFUSED,
TLS), HTTP 5xx, and malformed or non object payloads (a proxy answering 200 with an HTML
error page is degraded whatever the status line says). Not counted: HTTP 4xx, which means
the SDK sent something the gateway disliked and waiting cannot fix, and `circuit_open` itself.

In HALF_OPEN exactly one probe is admitted; concurrent callers are rejected until the
probe reports. That single probe rule depends on invariant A1, and the abandoned probe
timeout is its backstop: `probeInFlight` is cleared only by `onSuccess()`/`onFailure()`,
so without the timeout one unreported probe would reject every request for the life of
the process with no timer able to recover it.

`getState()` reports a timed out OPEN as HALF_OPEN for external inspection, before
`allowRequest()` mutates the state.

### 5.5 Retry and backoff

- Attempts: `1 + maxRetries` for a retryable call, 1 otherwise. `maxRetries` default 2,
  clamped to 0 to 10.
- Delay before attempt n (1 based): `500ms * 2^(n-1)` plus uniform jitter of 0 to 50
  percent of that. Maximum total backoff at defaults is about 2.25 seconds.
- Retryable classification: `circuit_open` never; if `httpStatus` is known, only >= 500;
  otherwise timeouts and network category errors. Parse failures are not retryable but
  do count as breaker failures.
- Abort detection is by error `name` (`AbortError`, `TimeoutError`), not
  `instanceof DOMException`, so a custom `fetch` that rejects with a plain `Error` is
  still classified as a timeout.
- Per attempt timeout is `timeoutMs` (default 30000, accepted range 1000 to 300000).

### 5.6 Webhook verification

`inspect(source)` executes in this order. Each step can only reject with the reason named.

1. `extractOrderId(source)` reads `orderId` then `mdOrder` from a string, a URL, a Web
   `Request`, or a plain object. A URL with duplicate query keys is rejected outright.
   The value must match `^[a-zA-Z0-9-]{1,128}$`. Failure: `invalid_source`.
2. If `callbackSecret` is set, `verifyCallbackChecksum` recomputes HMAC-SHA256 over the
   signed string and compares in constant time. Failure: `bad_signature`. If no secret is
   configured but a callback carries `checksum`, one warning is logged and the signature
   is ignored.
3. Sliding window rate limit, after the signature check so forged traffic cannot exhaust
   the window. Failure: `rate_limited`.
4. Per `orderId` in flight lock. A concurrent call for the same order awaits the first
   and returns its response with `duplicate: true`.
5. `onCheckDuplicate(orderId)` and `onResolveAmount(orderId)` run in parallel. A nullish
   amount means the order is unknown: return without touching the gateway. Failure:
   `unknown_order`.
6. First delivery calls `confirm(orderId, expectedAmount)`, which verifies the amount on
   success. A replay calls `status(orderId)` instead, because
   `/public/acknowledgeTransaction.do` is a mutating acknowledgement that must not be
   re-fired, and re-asserts the amount explicitly.
7. `onMarkProcessed(orderId)` runs only on a first delivery that reached a terminal
   `OrderStatus`: captured (2), refunded (4), reversed (3).
8. The in flight lock is released in `finally`.

Signature and re-fetch answer different questions. A valid signature proves the
notification was issued by the gateway; it does not prove the payload reflects current
state, and a replay carries a perfectly valid one. Only live re-verification settles that.

Callback signed string: all parameters except `checksum` and `sign_alias`, sorted by name,
rendered as `name;value;` and concatenated. HMAC-SHA256 with the bank shared secret, hex,
compared case insensitively in constant time.

Distributed deployments: the in process duplicate `Set` and the in flight lock are per
process. Multi instance deployments must supply `onCheckDuplicate` and `onMarkProcessed`
backed by a shared store with atomic check and mark semantics (Redis `SETNX`, database
`INSERT ... ON CONFLICT DO NOTHING`). The handler warns at construction time when the in
memory fallback is in use.

### 5.7 Terminal ID injection

Two independent defences, kept deliberately:

- `buildData()` destructures `force_terminal_id` out of `_userDefinedFields` and
  re-injects the credential store value after spreading the remainder.
- `assertUserField` rejects `force_terminal_id`, `__proto__`, `constructor` and
  `prototype` at setter time.

The validator alone is insufficient because a caller can construct the user field object
directly; the strip alone is sufficient but silent. Both stay.

## 6. Error classification

| `ErrorCode` | Exception | Notes |
| - | - | - |
| `0` or absent | none | |
| `1` | `SatimGatewayError` | duplicate order. `safeRegister` translates it to `SatimDuplicateOrderError` |
| `3` | `SatimGatewayError` | unknown currency |
| `4` | `SatimGatewayError` | missing parameter |
| `5` | `SatimInvalidCredentialsError` | on `/deposit.do`, `/refund.do`, `/reverse.do`, `/decline.do` the message says the terminal may lack entitlement and points at `checkCapabilities()` |
| `6` | `SatimInvalidArgumentError` | invalid or unknown order id |
| `7` | `SatimGatewayError` | system error |
| any other non zero | `SatimUnexpectedResponseError` | `errorCategory: "gateway"` |

HTTP 401 and 403 also map to `SatimInvalidCredentialsError`: `acknowledgeTransaction.do`
reports bad credentials as 401 while `register.do` reports `ErrorCode 5`.

Gateway messages are stripped of bytes outside `\x20-\x7E` and truncated to 200
characters before being interpolated into any message. `SatimDuplicateOrderError` applies
the same sanitiser to `merchantRef`.

`SatimUnexpectedResponseError` exposes a closed `errorCategory` enum
(`network`, `timeout`, `parse`, `http`, `gateway`, `circuit_open`, `unknown`) plus
`isTimeout`, `httpStatus`, `gatewayErrorCode`, `gatewayErrorMessage`. Raw transport error
messages and stack traces are not retained, so an error reporter cannot leak a request
URL or form body through this class.

## 7. Order status state machine

`OrderStatus` values as documented by BPC, the platform SATIM runs. Each maps to exactly
one predicate on `ConfirmResponse`.

| Value | Meaning | Predicate | Terminal |
| - | - | - | - |
| `0` | registered, not paid | `isPending()` | no |
| `1` | pre-authorized, not captured | `isPreAuthorized()` | no |
| `2` | authorized and captured | `isSuccessful()` | yes |
| `3` | authorization voided | `isReversed()` | yes |
| `4` | refunded | `isRefunded()` | yes |
| `5` | issuer ACS started 3-D Secure | `isPending()` | no |
| `6` | authorization declined | `isRejected()` | no |
| `7` | pending payment | `isPending()` | no |
| `8` | intermediate multi part capture | `isPartiallyCaptured()` | no |
| absent | decline, cancel, expiry, or transport level failure | composite predicates | no |

"Terminal" is the webhook marking criterion in section 5.6. Status `6` is deliberately
not terminal: the same order can carry a later successful card retry.

Capture is `/deposit.do`, not `confirm()`. `confirm()` acknowledges a transaction through
SATIM's own `/public/acknowledgeTransaction.do`, which is not part of BPC's documented API.

## 8. Predicate mutual exclusivity contract

Defined in `src/responses/confirm.ts`; this is the canonical restatement. For any well
formed `ConfirmOrderResponse`, exactly one predicate returns `true`.

| Group | Predicate | Condition |
| - | - | - |
| Leaf | `isPending` | `OrderStatus` in {`0`, `5`, `7`} |
| Leaf | `isPreAuthorized` | `OrderStatus == "1"` |
| Leaf | `isSuccessful` | `OrderStatus == "2"` |
| Leaf | `isReversed` | `OrderStatus == "3"` |
| Leaf | `isRefunded` | `OrderStatus == "4"` |
| Leaf | `isPartiallyCaptured` | `OrderStatus == "8"` |
| Leaf and composite | `isRejected` | `OrderStatus == "6"`, or: no known status, not expired, not cancelled, error signal present, and (`actionCode` in {`2003`, `111`} or `params.respCode` not in {`""`, `"00"`} or the message contains "payment is declined") |
| Composite | `isExpired` | no known status and `actionCode == "-2007"` |
| Composite | `isCancelled` | no known status, not expired, error signal present, and (`actionCode == "10"` or the message contains "payment is cancelled") |
| Catch all | `isFailed` | no known status and none of the composites matched |

"Known status" is any of `0`, `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`.
"Error signal" is `ErrorCode` present and not `"0"`, or `params` present, or `actionCode` present.

The dependency chain is acyclic: composites read leaves, `isFailed` reads everything above
it, nothing reads `isFailed`. Message matching is an English only fallback and the SDK
defaults to `language=FR`, so `actionCode` is authoritative and the string test is last.
Adding a predicate requires extending the known status set and the exclusion list of
every predicate after it in the chain.

## 9. Immutability mechanics

`clone()` uses `Object.create(Object.getPrototypeOf(this))` and assigns every field
explicitly. It is not `Object.assign`, so `Satim` can override it to carry
`httpClientService`, `_hasCustomHttpClient` and `_httpClientOptions` without copying
internal state from the wrong source. `_userDefinedFields` is copied as a fresh object,
not shared by reference.

`setTestMode()` is overridden on `Satim`: it rebuilds `HttpClientService` for the new mode
unless the caller injected a custom client, in which case the injected instance is kept.

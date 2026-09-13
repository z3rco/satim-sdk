# Security

Threat model, implemented controls, and residual risk for satim-sdk. Implementation
detail behind each control is in [ARCHITECTURE.md](./ARCHITECTURE.md).

Reporting: do not open a public issue. Use
[GitHub Security Advisories](https://github.com/z3rco/satim-sdk/security/advisories/new).

## 1. Trust boundaries

| Boundary | Direction | Trust |
| - | - | - |
| Merchant code to SDK | in | untrusted input, validated at every setter |
| SDK to SATIM gateway | out | TLS only, credentials in every POST body |
| SATIM gateway to SDK | in | untrusted payload, schema validated, PII redacted on export |
| SATIM callback to merchant endpoint | in | untrusted, optionally signed, always re-verified live |
| Cardholder browser redirect to merchant | in | fully attacker controlled, never trusted as payment proof |

## 2. Threat matrix

| Threat | Control | Residual risk |
| - | - | - |
| Credential disclosure through logs or serialization | module private `WeakMap`, redacting `toJSON`/inspect/`toString`, anti caching headers, hashed in flight keys | POST bodies still carry credentials; proxy and APM body logging is out of the SDK's reach |
| Credentials over an unverified TLS channel | hard refusal when `NODE_TLS_REJECT_UNAUTHORIZED=0` | env var read only where `process` exists |
| Terminal ID injection | `force_terminal_id` stripped from caller fields and re-injected from the credential store, plus setter time rejection | none known |
| SSRF through callback and return URLs | private and reserved IPv4/IPv6 ranges, internal hostnames, non standard IP encodings rejected | DNS rebinding after validation, see 6.1 |
| Open redirect through a tampered `formUrl` | HTTPS plus `satim.dz` hostname allowlist on `getUrl()` and `redirectResponse()` | none known |
| Partial payment manipulation | `confirm()` verifies the settled amount against merchant state, no opt out | `status()` does not verify; the caller must call `verifyAmount()` |
| Currency substitution | `confirm()` cross checks the settled currency against the registered one | applies to successful responses only |
| Double charge or double refund on retry | mutating endpoints are never retried; registration retries only with an idempotency key | a merchant calling a mutation twice is still two calls |
| Forged callback | HMAC-SHA256 `checksum` verified in constant time before any gateway call | unsigned mode accepted only with an explicit opt in |
| Replayed callback | live state re-fetch on every callback, terminal state marking, per order in flight lock | cross instance atomicity is the operator's responsibility, see 5.2 |
| Callback parser differential | callbacks with duplicate query keys are rejected | none known |
| Callback flooding | sliding window rate limiter, malformed sources rejected before the limiter | the window is global across orders, see 5.3 |
| Memory exhaustion by a hostile endpoint | response bodies streamed with a 1 MiB cap; duplicate set bounded at 10000; URL cache bounded at 512 | reachable only through a custom `baseUrl` |
| Cascading failure against a degraded gateway | circuit breaker with single probe recovery | |
| PII leakage into logs | `Ip`, `Pan`, `cardholderName`, `expiration` redacted in `getRawResponse()` | typed accessors return the real values on request |
| Gateway detail leaking into merchant logs | messages stripped to printable ASCII and truncated to 200 chars; transport errors expose a category enum only | |
| Log or terminal escape injection | `merchantRef` sanitized before interpolation into `SatimDuplicateOrderError` | |
| Prototype pollution through `jsonParams` | `__proto__`, `constructor`, `prototype` rejected at setter time | |
| Duck typed bypass of TypeScript checks | runtime `typeof` guards on credentials, description, language and amounts | |
| Amount precision loss | single guarded conversion path, `MAX_SAFE_INTEGER` bound on parsing | |

## 3. Credential handling

The SATIM API requires `userName` and `password` as form parameters on every request.
That exposure cannot be removed, only contained.

| Control | Effect |
| - | - |
| `WeakMap` isolation | credentials are not own properties; `Object.keys`, `Reflect.ownKeys`, `JSON.stringify`, `console.log` and prototype traversal expose nothing |
| Serialization redaction | `toJSON()`, the Node inspect symbol, `toString()` and `Symbol.toPrimitive` return `[REDACTED]` |
| Anti caching headers | `Cache-Control: no-store, no-cache` and `Pragma: no-cache` on every outbound request |
| Hashed in flight keys | request coalescing keys on SHA-256 of the form body, so the password is not left readable in a `Map` key |
| Immutable re-init | credentials cannot be re-set on an existing instance |
| Length bounds | username and password <= 100 chars, terminal id <= 16 chars |

Operator requirements:

1. Load credentials from environment variables or a secret manager. Never from source.
2. Never log raw request or response bodies. Reverse proxies, CDN edges, WAFs and APM
   agents all do this by default.
3. Prefer direct HTTPS to the gateway over TLS terminating proxies that inspect bodies.
4. Rotate credentials through CIBWeb on a schedule.

## 4. Response handling

Gateway responses are not signed. They are trusted over TLS and nothing else, so the SDK
constrains what a malformed or hostile response can do.

- Schema validation at construction. `RegisterResponse` requires non empty string
  `orderId` and `formUrl`; `ConfirmResponse` coerces `OrderStatus`, `ErrorCode` and
  `actionCode` from number to string and rejects any other type. Failures raise
  `SatimUnexpectedResponseError` immediately rather than propagating.
- The payload is `structuredClone`d into the wrapper at construction, so later mutation of
  the object the HTTP client parsed cannot change response state.
- `ConfirmResponse.getRawResponse()` returns a shallow copy with the four PII fields
  replaced by `"[REDACTED]"`. Nested objects such as `params` are shared by reference;
  do not mutate them.
- `formUrl` is accepted only over HTTPS and only for `satim.dz`, `cib.satim.dz`,
  `test.satim.dz` or `test2.satim.dz`, enforced on both `getUrl()` and `redirectResponse()`.
- Response bodies are streamed and rejected past 1 MiB.

Operator requirements:

1. Verify every payment server side with `confirm()` or `status()`. Redirect query
   parameters are attacker controlled.
2. `confirm(orderId, expectedAmount)` requires the expected amount and verifies it on
   success. There is no way to skip the check.
3. After `status()` or `statusExtended()`, call `verifyAmount()` yourself before fulfilling.

## 5. Callback verification

The handler never trusts the callback payload. It uses it only to learn which order to
re-read, then fetches authoritative state from the gateway.

Order of operations, and what each step rejects, is specified in ARCHITECTURE.md section 5.6.

### 5.1 Signed callbacks

BPC can sign notifications. Where a merchant profile is configured for it the callback
carries `checksum`, an HMAC-SHA256 over the other parameters sorted by name and joined as
`name;value;`, using a secret shared with the bank.

- Pass that secret as `callbackSecret`. The handler verifies before contacting the
  gateway and rejects a mismatch with `bad_signature`.
- To accept unsigned callbacks, pass `allowUnverifiedCallbacks: true`. Constructing a
  handler with neither option throws: the insecure mode is never a silent default.
- If a callback arrives carrying `checksum` while no secret is configured, the handler
  logs one warning. You do not need to know in advance whether signing is on.

A signature proves origin, not freshness or correctness. It does not prove the payload
reflects current state (a replay carries a valid one), and it does not prove the amount
matches your records. Verification is defence in depth on top of the re-fetch, never a
replacement for it.

### 5.2 Terminal state marking

An order is marked processed only once the gateway reports a state it can never leave:
captured (`OrderStatus` 2), refunded (4), or reversed (3).

Marking is one way: every later callback for a marked order returns `duplicate: true`,
which callers are told not to fulfil. Two cases must therefore not be marked early.

- Pre-authorized (1) is a fund hold awaiting capture. Marking it makes the capture
  callback arrive as a duplicate and the order is never fulfilled.
- Declined, cancelled and expired responses carry no `OrderStatus`. A customer who retries
  their card on the same order and succeeds would be charged without being fulfilled.

The cost of leaving a state unmarked is one extra `status()` read per redelivery.

### 5.3 Rate limiting

The sliding window is per handler instance and counts all orders. Over limit callbacks are
rejected, not queued. Well formed callbacks for unknown orders consume budget, because an
order is only known to be unknown after `onResolveAmount` runs. Malformed sources are
rejected before the limiter and cost nothing.

Use `inspect()` rather than `verify()` so `rate_limited` can be answered with 429 or a 5xx
and redelivered. Answering 200 tells SATIM the callback was handled and it will never
resend, silently losing a real payment notification.

### 5.4 Distributed deployment

The default duplicate tracking is an in process `Set`, bounded at 10000 entries. The in
flight lock is also per process. For Kubernetes, multiple dynos, or serverless:

1. Provide `onCheckDuplicate` and `onMarkProcessed` backed by a shared store.
2. Implement check and mark as a single atomic operation inside `onCheckDuplicate`
   (Redis `SETNX`, database `INSERT ... ON CONFLICT DO NOTHING`). The handler calls the
   two callbacks separately; cross instance correctness requires the atomic step to live
   in the check.

The handler warns at construction when the in memory fallback is active. Set
`suppressMultiInstanceWarning: true` only after confirming a single process deployment.

## 6. Known limitations

### 6.1 DNS rebinding

URL validation happens at configuration time only. The SDK performs no DNS resolution and
no re-validation at request time, so a hostname that resolved to a public address during
validation can later resolve to a private one.

The SDK does not fetch these URLs; they are handed to SATIM for callback delivery, so the
exposure is at the callback endpoint. Apply network level egress controls there.

### 6.2 Local development escape hatch

`allowPrivateUrls(true)` disables the private range checks for the instance it is called
on, so a local server can receive redirects and callbacks. It is off by default, is per
instance, never writes to the shared validation cache, and still rejects obfuscated IP
encodings. Enabling it in production re-opens the SSRF surface these checks exist to close.

### 6.3 Response authenticity

Gateway responses carry no MAC. Authenticity rests entirely on TLS. A caller supplied
`baseUrl` moves that trust to whatever host it names; the currency cross check in
`confirm()` and the `formUrl` allowlist exist partly to limit what a hostile `baseUrl` can
achieve, but a custom `baseUrl` is a deliberate trust decision by the merchant.

### 6.4 Error message content

SDK error messages may contain merchant supplied identifiers such as `merchantRef`. They
are sanitized to printable ASCII, but they are still internal data. Catch SDK errors at
your API boundary and return generic messages to end users.

## 7. Retry policy as a safety property

| Endpoint class | Retried | Reason |
| - | - | - |
| Reads (`status`, `statusExtended`) | yes | idempotent |
| Registration with an idempotency key | yes | the gateway deduplicates on `externalRequestId` |
| Registration without a key | no | a retry after a timeout can create a duplicate order (`ErrorCode 1`) |
| `confirm`, `deposit`, `refund`, `reverse`, `decline` | no | mutations with no idempotency primitive |
| Any 4xx | no | the gateway will give the same answer |
| Malformed payload | no | same |

Set `maxRetries: 0` in `HttpClientOptions` to disable retries entirely.

## 8. Circuit breaker as a safety property

- Every transport failure mode counts toward opening: timeouts, connection failures, 5xx,
  and malformed payloads. A proxy answering 200 with an HTML error page is degradation.
- HTTP 4xx does not count: a client side fault that waiting cannot fix.
- A single probe is admitted in HALF_OPEN. Concurrent requests are rejected, so a
  recovering gateway is not hit by a thundering herd.
- A probe whose outcome is never reported is treated as abandoned after `resetTimeoutMs`,
  so one lost request cannot leave the breaker rejecting traffic permanently.
- The `NODE_TLS_REJECT_UNAUTHORIZED=0` guard trips before the breaker gate, so a local
  misconfiguration is neither counted as a failure nor allowed to consume the probe.

## 9. Runtime type guards

Public setters enforce `typeof` at runtime, not only at compile time, because plain
JavaScript callers and `as any` casts bypass the type system.

| Input | Guard |
| - | - |
| `username`, `password`, `terminalId` | must be strings before trimming; objects carrying a `.trim()` method are rejected |
| `description` | must be a string before length and markup checks; a crafted `.length` cannot bypass the 600 char limit |
| `language` | must be a string before `.toUpperCase()` |
| amounts | must be numbers, finite, positive, within `MAX_SAFE_AMOUNT`, at most 2 decimals |
| order ids | string matching `^[a-zA-Z0-9-]+$`, at most 128 chars |
| user field values | strings at most 20 chars; keys non numeric, at most 128 chars, not reserved |

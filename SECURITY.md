# Security Considerations

This document outlines security characteristics, known limitations, and best practices when integrating the SATIM TypeScript SDK.

## TLS Verification

The SDK **actively refuses** to send any request if `NODE_TLS_REJECT_UNAUTHORIZED=0` is detected in the environment. This prevents credentials from being sent over an unverified TLS connection, even if a developer accidentally sets this flag during debugging.

## Credential Handling

The SATIM API requires `userName` and `password` to be sent as `application/x-www-form-urlencoded` POST parameters on every request. The SDK mitigates exposure through:

- **WeakMap isolation** — credentials cannot be enumerated via `Object.keys`, `JSON.stringify`, `console.log`, or prototype traversal.
- **Serialization redaction** — `toJSON()` and Node.js inspect handlers return `[REDACTED]` for all credential fields.
- **Anti-caching headers** — all outbound requests include `Cache-Control: no-store, no-cache` and `Pragma: no-cache` to prevent intermediary caching of credential-bearing POST bodies.
- **Hashed in-flight keys** — the request-deduplication map keys on a SHA-256 of the form body rather than the body itself, so the merchant password is not left readable in a `Map` key for the duration of a request.

### Recommendations

> [!CAUTION]
> POST form bodies may be logged by reverse proxies, CDN edge nodes, WAFs, and APM tools. **Never log raw request or response bodies** in your application.

- Store credentials in environment variables or a secrets manager, never in source code.
- Use direct HTTPS connections to the SATIM gateway — avoid TLS-terminating proxies that inspect POST bodies.
- Rotate credentials regularly via CIBWeb.

## Response Integrity

The SATIM/BPC gateway **does not** provide HMAC-based response signing. Responses are trusted over the TLS channel without additional MAC verification.

- **Runtime schema validation** — both `RegisterResponse` and `ConfirmResponse` validate the shape of the gateway JSON at construction time. Malformed or unexpected responses are rejected immediately with a `SatimUnexpectedResponseError` rather than propagating silently.
- `getRawResponse()` returns a **deep clone** (`structuredClone`) to prevent consumers from accidentally mutating internal SDK state.
- Error objects expose only a safe `errorCategory` classification (`"network"`, `"timeout"`, `"parse"`, `"http"`, `"gateway"`, `"unknown"`) — no raw error messages, stack traces, or system codes are retained.
- **Gateway error message sanitization** — error messages from the BPC gateway are truncated to 200 characters and stripped of non-printable characters before being included in `SatimGatewayError` or `SatimUnexpectedResponseError`, preventing internal gateway details from leaking into application logs or error reporters.

### Recommendations

- **Always verify payments server-side** using `confirm()` or `status()` — never rely on client-side redirect parameters alone.
- **`confirm()` requires `expectedAmount`** and automatically calls `verifyAmount()` to detect partial-payment manipulation. There is no way to skip this check.
- **Validate `formUrl` origin** — the SDK's `redirectResponse()` method enforces HTTPS and rejects URLs not pointing to trusted `*.satim.dz` domains.

## Webhook Verification (Zero-Trust Model)

Since SATIM does not sign callback payloads, the SDK takes a strictly stronger approach than HMAC signature verification: **zero-trust server-to-server verification**.

The `createWebhookHandler()` method returns a handler that:

1. **Never trusts the callback payload** — the callback body is used only to extract the `orderId`. All payment state is fetched live from the SATIM gateway via `confirm()`.
2. **Verifies the amount automatically** — successful payments are checked against the expected amount from your database, preventing partial-payment manipulation.
3. **Rejects duplicate callbacks** — pluggable persistence (in-memory, Redis, database) prevents double-fulfillment.
4. **Rate-limits callbacks** — a sliding window rate limiter protects against callback flooding attacks.
5. **Sanitizes the orderId** — validates format before making any gateway call.

### Why this is stronger than HMAC

HMAC signature verification (as used by Chargily, Stripe, etc.) proves that the payload was sent by the gateway. However:

- A valid signature does not prove the payload reflects **current** state — replayed or stale webhooks pass signature checks.
- A valid signature does not verify that the **amount** matches what you expected — a compromised or buggy gateway could send a valid signature on a wrong amount.

The zero-trust model fetches live authoritative state on every callback. Even a perfectly forged or replayed callback only triggers a fresh server-to-server verification against the real gateway. The amount is always verified against your own source of truth.

### Terminal-state marking

An order is marked processed only once the gateway reports a state it can never leave: deposited (`OrderStatus` `"2"`), refunded (`"4"`), or reversed (`"3"`). Everything else stays unmarked so subsequent callbacks keep re-verifying.

This matters because marking is one-way: every later callback for a marked order arrives as `duplicate: true`, which callers are told not to fulfil. Two states in particular must not be marked early:

- **Pre-authorized** (`"1"`) is a fund hold awaiting capture. Marking it means the capture callback arrives as a duplicate and the order is never fulfilled.
- **Declined, cancelled and expired** responses carry no `OrderStatus` at all. A customer who retries their card on the same order and succeeds would otherwise be charged without being fulfilled.

### Rate-limited callbacks

The handler's sliding window is per handler instance and counts all orders. Callbacks over the limit are **rejected, not queued**. Use `handler.inspect(source)` rather than `handler.verify(source)` so a `rate_limited` rejection can be answered with `429` (or any 5xx) and redelivered — answering `200` tells SATIM the callback was handled and it will never resend, silently losing a real payment notification.

## SSRF Protection

All user-supplied URLs (`returnUrl`, `failUrl`, `dynamicCallbackUrl`) are validated at configuration time against:

- Private/reserved IPv4 ranges (loopback, RFC 1918, link-local, cloud metadata)
- Private/reserved IPv6 ranges (loopback, unique local, link-local, IPv4-mapped)
- Non-standard IP encodings (decimal, octal, hex) that bypass naive filters
- Known internal hostnames (`localhost`, `metadata.google.internal`)

### Local development

`allowPrivateUrls(true)` disables the private-address checks for the
instance it is called on, so a local server can receive redirects and
callbacks. It is off by default, is per instance, never populates the
shared validation cache, and still rejects obfuscated IP encodings. It is a
development affordance: enabling it in production re-opens the SSRF surface
these checks exist to close.

### Known Limitation: DNS Rebinding

URL validation occurs **at configuration time only**. The SDK does not perform DNS resolution or re-validation at request time. A domain that resolves to a public IP during validation could later resolve to a private IP via DNS rebinding.

In practice, this risk is mitigated because these URLs are sent **to the SATIM gateway** for callbacks — the SDK itself does not fetch them. However, merchants should implement network-level egress controls on callback endpoints as defense in depth.

## Retry Behavior

The HTTP client retries transient errors (5xx responses, timeouts, and connection-level failures such as DNS or TLS errors) up to 2 times with exponential backoff and jitter. Malformed payloads and 4xx responses are never retried — the gateway will produce the same answer. This prevents a single transient failure from breaking a payment flow while avoiding accidental gateway overload.

**Registration endpoints** (`/register.do`, `/registerPreAuth.do`) are **only retried when an idempotency key is set** (via `idempotencyKey()` or automatically by `safeRegister()`/`safeRegisterPreAuth()`). Without an idempotency key, retrying a registration after a timeout could result in duplicate orders (ErrorCode 1).

Set `maxRetries: 0` when constructing `HttpClientService` to disable retries for all endpoints if needed.

## Runtime Type Guards

All public-facing setter methods enforce `typeof` checks at runtime, not just at compile time. This prevents duck-typing bypass attacks where JavaScript callers pass crafted objects that satisfy TypeScript's structural type system but carry malicious payloads:

- **Credentials** — `username`, `password`, and `terminalId` are validated as strings before any processing. Objects with `.trim()` methods are rejected.
- **Description** — validated as a string before length and content checks, preventing objects with crafted `.length` properties from bypassing the 600-character limit.
- **Language** — validated as a string before `.toUpperCase()` is called, preventing objects with crafted methods.
- **Amount** — validated as a number (already present since v1.0).

These guards close a class of attacks where TypeScript's compile-time checks are bypassed by plain JavaScript callers or `as any` casts.

## Circuit Breaker

The HTTP client includes a circuit breaker that tracks consecutive transient failures and opens the circuit when a threshold is exceeded. This prevents cascading failures from overwhelming a degraded gateway.

- **Complete failure accounting** — every transport failure mode counts toward opening the circuit: timeouts, connection failures, 5xx responses, and malformed payloads (a gateway proxy answering `200` with an HTML error page is degraded, whatever the status line says). 4xx responses do not, since those indicate a client-side fault that waiting will not fix.
- **HALF_OPEN probe safety** — only a single probe request is allowed through when the circuit transitions from OPEN to HALF_OPEN. Concurrent requests during the probe window are rejected immediately, preventing a flood of requests to a recovering gateway.
- **Automatic recovery** — a successful probe closes the circuit; a failed probe re-opens it with a fresh reset timer. A probe whose outcome is never reported is treated as abandoned after `resetTimeoutMs` and a fresh probe is admitted, so no single request can leave the breaker permanently rejecting traffic.
- **Configuration faults are not gateway faults** — the `NODE_TLS_REJECT_UNAUTHORIZED=0` guard trips before the breaker gate, so a local misconfiguration neither counts as a failure nor consumes the single probe.

## Amount Precision Safety

Gateway response amounts are validated against `Number.MAX_SAFE_INTEGER` before conversion. Amounts exceeding JavaScript's safe integer range return `undefined` from `getAmount()` and `getDepositAmount()` rather than silently losing precision. This prevents incorrect amount comparisons in the `verifyAmount()` flow.

## Webhook Distributed Deployment

The default in-memory duplicate tracking (`Set<string>`) is **per-process only**. In multi-instance deployments (Kubernetes, serverless, multiple dynos):

- Provide `onCheckDuplicate` and `onMarkProcessed` backed by a shared store (Redis, database).
- Your implementation **must use atomic check-and-mark** (e.g., Redis `SETNX`, database `INSERT ... ON CONFLICT`) to prevent races across instances.
- The SDK's in-flight lock only serializes concurrent calls within a single Node.js process.

The SDK warns at construction time when using the in-memory fallback. Set `suppressMultiInstanceWarning: true` only if you have confirmed single-process deployment.

## Error Message Exposure

SDK error messages (e.g., `SatimDuplicateOrderError`) may include internal identifiers like `merchantRef`. Always catch SDK errors and return generic messages to end users. Never expose raw error messages in API responses or user-facing pages.

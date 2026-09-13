# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Webhook handler requires an explicit decision about unsigned callbacks.** Pass
  `callbackSecret` to verify signed callbacks, or `allowUnverifiedCallbacks: true` to
  accept unsigned ones (guarded only by live re-fetch and amount verification).
  Constructing with neither now throws. Breaking, and deliberate: the insecure mode must
  never be the silent default.
- **Closed a callback parser differential.** `extractOrderId` took the first duplicate
  query value while `extractParams` took the last, so a signed callback for order B could
  be replayed as `?orderId=VICTIM&orderId=B`. Any callback carrying duplicate query keys
  is now rejected.
- **`getUrl()` enforces the HTTPS plus `satim.dz` allowlist** that `redirectResponse()`
  already applied. Merchants redirecting from `getUrl()` no longer lose the open redirect
  protection.
- **SSRF guard extended:** CGNAT `100.64.0.0/10` (including cloud metadata
  `100.100.100.200`), `198.18.0.0/15`, multicast `224.0.0.0/4`, reserved `240.0.0.0/4`,
  trailing dot hostnames, IPv6 6to4 and Teredo.
- **Response bodies are streamed with a 1 MiB cap**, so a hostile endpoint (reachable only
  through a custom `baseUrl`) cannot exhaust memory.
- **`merchantRef` is sanitized** before interpolation into `SatimDuplicateOrderError`,
  closing terminal and log escape sequence injection.
- **`confirm()` cross checks the settled currency** against the registered one on success.
- **The in memory duplicate set is bounded** at 10000 entries, FIFO.
- `toMinorUnits` throws a typed `SatimInvalidArgumentError` rather than a bare `Error`, and
  rejects a positive amount that rounds to 0 minor units.

### Fixed

- **Webhook: paid orders could be left unfulfilled.** Orders were marked processed whenever
  the response was not `isPending()`, which wrongly covered pre-authorized holds and
  declined attempts. A pre-auth capture, or a successful card retry after a decline, then
  arrived as `duplicate: true` and callers were told not to fulfil it. Marking now requires
  a terminal `OrderStatus`: captured, refunded, or reversed.
- **Circuit breaker ignored the most common outage.** Connection level failures (DNS,
  ECONNREFUSED, TLS) and malformed payloads reported nothing, so the breaker never opened
  on them. Every transport failure mode is now counted. HTTP 4xx deliberately is not.
- **Circuit breaker could wedge permanently.** A HALF_OPEN probe failing through an
  unreported path left `probeInFlight` set, and the breaker rejected every later request
  for the life of the process with no timer able to recover it. All paths now report an
  outcome, and an unreported probe is treated as abandoned after `resetTimeoutMs`.
- **Timeouts were misclassified under a custom `fetch`.** Abort detection used
  `instanceof DOMException`, so a custom `fetch` (the documented undici `Pool` path)
  rejecting with a plain `Error` named `AbortError` was reported as a generic network
  error, losing `isTimeout` and skipping retries. Detection is now by error `name`.
- **`verifyAmount` rejected valid successful payments.** Gateway amounts serialised with
  trailing zeros (`"5000.00"`) failed the integer check and threw. Integral minor units are
  now accepted in either form; genuinely fractional amounts are still rejected.
- The `NODE_TLS_REJECT_UNAUTHORIZED=0` guard no longer counts as a gateway failure or
  consumes the breaker probe, so fixing the environment no longer leaves a circuit open
  behind it.
- **The published package could not be imported from plain Node.** Relative imports were
  emitted without file extensions, which Node's ESM resolver rejects
  (`ERR_MODULE_NOT_FOUND`), so the package only worked through a bundler. Specifiers now
  carry `.js`, the compiler is set to `NodeNext` which enforces it at build time, and
  `npm run smoke` loads `dist/` in plain Node on CI.
- Restored words mangled by an earlier find and replace in the published API docs
  ("alphanumeric", "non-numeric").
- Corrected documentation that did not match the implementation: minor unit conversion
  never used `toPrecision(12)`; `register()` does retry when an idempotency key is set;
  `confirm()` posts to `/public/acknowledgeTransaction.do`; `setTestMode` routes to
  `test2.satim.dz`; `description()` allows 600 characters.

### Added

- `WebhookHandler.inspect(source)` returning a `WebhookOutcome` that names the rejection
  reason (`invalid_source`, `bad_signature`, `rate_limited`, `unknown_order`). `verify()`
  collapses all of them to `null`, so a rate limited callback answered with 200 was
  silently discarded and never redelivered.
- Regression suites `tests/regressions.test.ts` and `tests/crypto.test.ts`.

### Changed

- **Order numbers are 10 character base36, previously 10 digit.** The `9 * 10^9` numeric
  space collided at roughly 21000 derived references (measured), and a collision makes the
  gateway reject a new order as a duplicate. The `36^10` space moves the 50 percent
  birthday point to about 60 million. Affects `deriveOrderNumber()` and SDK generated
  defaults; both stay inside SATIM's AN.10 alphanumeric constraint. If your terminal is
  provisioned for numeric order numbers only, set one explicitly with `.orderNumber()`.
- **The package no longer imports `node:crypto`**, so it loads on Vercel and Netlify Edge
  and on Cloudflare Workers without `nodejs_compat`. SHA-256 is implemented in tree
  (differentially tested against `node:crypto`) because `crypto.subtle` is async and these
  derivations are synchronous. Randomness comes from `crypto.getRandomValues`.
- Connection level failures are retried for idempotent calls, alongside timeouts and 5xx.
- The webhook replay path re-reads state with `status()` instead of re-acknowledging with
  `confirm()`, and still verifies the amount.
- The request coalescing map keys on SHA-256 of the form body rather than the body itself,
  keeping the merchant password out of `Map` keys.
- Package renamed from `satim-module` to `satim-sdk`, matching the repository and the
  documentation. Neither name had been published.
- `exports` lists `"types"` before `"import"` so TypeScript resolves declarations
  correctly. Releases publish with provenance attestation.

## [1.0.0] 2026-05-26

### Added

- `Satim` client with an immutable fluent configuration API.
- `register()` and `registerPreAuth()` for CIB and Edahabia payment registration.
- `confirm()` with automatic amount verification against partial capture manipulation.
- `status()` with retry on transient failures.
- `refund()` and `reverseOrder()` for post capture operations.
- `safeRegister()` and `safeRegisterPreAuth()` with deterministic idempotency keys derived
  from `merchantRef`.
- `RegisterResponse` and `ConfirmResponse` typed wrappers with the full predicate set.
- Zero trust webhook handler re-verifying every callback server to server against the
  gateway, with replay protection and rate limiting.
- SSRF protection covering private IP ranges, cloud metadata endpoints and non standard IP
  encodings.
- Credential isolation in a module private `WeakMap`.
- IEEE-754 safe minor unit conversion with sub centime rejection.
- Circuit breaker for transient failure isolation.
- Strict mode TypeScript coverage with zero runtime dependencies.
- Node.js 20 and above, Bun 1.0 and above, Deno 1.28 and above, Cloudflare Workers.

[Unreleased]: https://github.com/z3rco/satim-sdk/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/z3rco/satim-sdk/releases/tag/v1.0.0

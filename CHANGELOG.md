# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Webhook: paid orders could be left unfulfilled.** Orders were marked processed whenever the response was not `isPending()`, which wrongly covered pre-authorized holds and declined attempts. A pre-auth capture, or a customer's successful card retry after a decline, then arrived as `duplicate: true` and callers were told not to fulfil it. Marking now requires a terminal `OrderStatus` — deposited, refunded, or reversed.
- **Circuit breaker ignored the most common outage.** Connection-level failures (DNS, ECONNREFUSED, TLS) and malformed payloads reported nothing to the breaker, so it never opened on them. Every transport failure mode is now counted; 4xx responses deliberately are not.
- **Circuit breaker could wedge permanently.** A `HALF_OPEN` probe that failed through an unreported path left `probeInFlight` set, and the breaker rejected every subsequent request for the life of the process with no timer able to recover it. All request paths now report an outcome, and an unreported probe is treated as abandoned after `resetTimeoutMs`.
- **Timeouts were misclassified under a custom `fetch`.** Abort detection used `instanceof DOMException`, so a custom `fetch` (the documented undici `Pool` path) rejecting with a plain `Error` named `AbortError` was reported as a generic network error, losing `isTimeout` and skipping retries. Detection is now by error `name`.
- **`verifyAmount` rejected valid successful payments.** Gateway amounts serialised with trailing zeros (`"5000.00"`) failed the integer check and threw. Integral minor units are now accepted in either form; genuinely fractional amounts are still rejected.
- The `NODE_TLS_REJECT_UNAUTHORIZED=0` guard no longer counts as a gateway failure or consumes the breaker's probe, so fixing the environment no longer leaves a circuit open behind it.
- **The published package could not be imported from plain Node.** Relative imports were emitted without file extensions, which Node's ESM resolver rejects (`ERR_MODULE_NOT_FOUND`), so the package only worked through a bundler. Specifiers now carry `.js` and the compiler is set to `NodeNext`, which enforces this at build time; `npm run smoke` loads `dist/` in plain Node and runs in CI.
- Restored words mangled by an earlier find-and-replace in the published API docs ("alphanumeric", "non-numeric").
- Corrected documentation that did not match the implementation: the minor-unit conversion never used `toPrecision(12)`; `register()` does retry when an idempotency key is set; `confirm()` posts to `/public/acknowledgeTransaction.do`; `setTestMode` routes to `test2.satim.dz`; `description()` allows 600 characters.

### Added

- `WebhookHandler.inspect(source)` returning a `WebhookOutcome` that names the rejection reason (`invalid_source`, `rate_limited`, `unknown_order`). `verify()` collapses all three to `null`, so a rate-limited callback answered with `200` was silently discarded and never redelivered.
- Regression suites `tests/regressions.test.ts` and `tests/crypto.test.ts`.

### Changed

- **Order numbers are now 10-character base-36 rather than 10-digit.** The `9 × 10^9` numeric space collided at roughly 21 000 derived references (measured), and a collision makes the gateway reject a new order as a duplicate. The `36^10` space moves the 50 % birthday point to ~60 million. Affects `deriveOrderNumber()` and SDK-generated defaults; both remain within SATIM's AN.10 alphanumeric constraint. If your terminal is provisioned for numeric order numbers only, set one explicitly with `.orderNumber()`.
- **The package no longer imports `node:crypto`**, so it loads on Vercel/Netlify Edge and on Cloudflare Workers without `nodejs_compat`. SHA-256 is implemented in-tree (differentially tested against `node:crypto`) because `crypto.subtle` is async and these derivations are synchronous; randomness comes from `crypto.getRandomValues`.
- Connection-level failures are now retried for idempotent calls, alongside timeouts and 5xx.
- The webhook replay path re-reads state with `status()` instead of re-acknowledging with `confirm()`, and still verifies the amount.
- The request-deduplication map keys on a SHA-256 of the form body rather than the body itself, keeping the merchant password out of `Map` keys.
- Package renamed from `satim-module` to `satim-sdk`, matching the repository and documentation. Neither name had been published.
- `exports` now lists `"types"` before `"import"` so TypeScript resolves declarations correctly; releases publish with `--provenance`.

## [1.0.0] - 2026-05-26

### Added

- `Satim` client with fluent immutable configuration API
- `register()` and `registerPreAuth()` for CIB and Edahabia payment registration
- `confirm()` with automatic amount verification to prevent partial-capture manipulation
- `status()` with automatic retry on transient failures
- `refund()` and `reverseOrder()` for post-capture operations
- `safeRegister()` and `safeRegisterPreAuth()` with deterministic idempotency keys derived from `merchantRef`
- `RegisterResponse` and `ConfirmResponse` typed wrappers with full status predicate set
- Zero-trust webhook handler that re-verifies every callback server-to-server against the gateway (SATIM does not sign callbacks), with replay protection and rate limiting
- SSRF protection against private IP ranges, cloud metadata endpoints, and non-standard IP encodings
- Credential isolation via module-private `WeakMap` — credentials never appear in `JSON.stringify()` or `console.log()` output
- IEEE 754-safe minor-unit conversion with sub-centime rejection
- Circuit breaker for transient failure isolation
- Full TypeScript strict-mode coverage with zero runtime dependencies
- Support for Node.js ≥ 20, Bun ≥ 1.0, Deno ≥ 1.28, and Cloudflare Workers

[Unreleased]: https://github.com/z3rco/satim-sdk/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/z3rco/satim-sdk/releases/tag/v1.0.0

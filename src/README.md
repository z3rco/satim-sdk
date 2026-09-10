# src

Source root for the SATIM SDK. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for system-level design.

## Responsibility

Implement the SATIM REST client, gateway response wrappers, immutable fluent configuration, and zero-trust webhook handler. No runtime dependencies and no `node:` imports — the package relies only on Web-standard globals, so it loads unmodified on edge runtimes.

## Module map

Files are listed in dependency order — each module only imports from those above it.

| Module | Responsibility |
|--------|----------------|
| [`exceptions.ts`](./exceptions.ts) | Exception hierarchy (`SatimError` and subclasses, `SatimErrorCategory`). |
| [`types.ts`](./types.ts) | Public `SatimCredentials`, `Language`, `CurrencyCode`, gateway response interfaces. |
| [`crypto.ts`](./crypto.ts) | `sha256Hex`, `randomOrderNumber`, `hexToBase36`. Runtime-agnostic digest and CSPRNG, replacing `node:crypto`. |
| [`money.ts`](./money.ts) | `toMinorUnits`, `hasSubCentimePrecision`, `isWholeMinorUnits`, `MAX_SAFE_AMOUNT`. IEEE-754-safe currency arithmetic. |
| [`idempotency.ts`](./idempotency.ts) | `deriveIdempotencyKey`, `deriveOrderNumber`. Deterministic SHA-256 derivations for safe retries. |
| [`ssrf.ts`](./ssrf.ts) | `assertSafeUrl`. Private-IP, internal-hostname, and non-standard-IP-encoding rejection. |
| [`validation.ts`](./validation.ts) | Pure field validators (`assertRegisterAmount`, `assertOrderId`, `assertDescription`, etc.). |
| [`config.ts`](./config.ts) | `SatimConfig` base class. Module-private `WeakMap` credential store. Immutable fluent setters. |
| [`circuit-breaker.ts`](./circuit-breaker.ts) | `CircuitBreaker` class. CLOSED/OPEN/HALF\_OPEN state machine with single-probe recovery. |
| [`client.ts`](./client.ts) | `HttpClientService`. Form-encoded POST, retry loop, gateway-error translation. |
| [`responses/`](./responses/README.md) | `RegisterResponse`, `ConfirmResponse`, schema validators. See [`responses/README.md`](./responses/README.md). |
| [`webhook/`](./webhook/README.md) | Zero-trust callback handler and supporting primitives. See [`webhook/README.md`](./webhook/README.md). |
| [`Satim.ts`](./Satim.ts) | Public client facade. Extends `SatimConfig`, owns the HTTP client, exposes endpoint methods. |
| [`index.ts`](./index.ts) | Public barrel export. |

## Compatibility shims

Three files re-export from the new module locations to preserve legacy import paths from before the directory split. They contain no logic of their own:

- [`utils.ts`](./utils.ts) → re-exports from `money.ts` and `idempotency.ts`
- [`responses.ts`](./responses.ts) → re-exports from `responses/register.ts` and `responses/confirm.ts`
- [`webhook.ts`](./webhook.ts) → re-exports from `webhook/handler.ts`

Consumers should prefer importing from the package root (`import { Satim } from "satim-sdk"`).

## External dependencies

| Dependency | Used by | Why |
|------------|---------|-----|
| `crypto.getRandomValues` (Web API) | `crypto.ts` | CSPRNG for default order numbers. SHA-256 is implemented in-tree so it stays synchronous (`crypto.subtle` is async) and `node:crypto`-free. |
| `TextEncoder` (Web API) | `crypto.ts` | UTF-8 encoding for the digest input. |
| `fetch` (Web API) | `client.ts` | HTTP transport. Available natively on Node 18+, Bun, Deno, Cloudflare Workers. |
| `AbortController` (Web API) | `client.ts` | Per-request timeouts. Aborts are detected by error `name`, not by `instanceof DOMException`, so custom `fetch` implementations classify correctly. |
| `URL`, `URLSearchParams` (Web API) | `client.ts`, `ssrf.ts`, `webhook/extract.ts` | URL parsing and form-body encoding. |
| `structuredClone` (Web API) | `responses/register.ts`, `responses/confirm.ts` | Deep-clone gateway payloads at the SDK boundary. |

No `package.json` runtime dependencies are declared. `devDependencies` cover the TypeScript compiler and the test runner only.

## Impact of changes

| Editing here | Potentially affects |
|--------------|---------------------|
| `exceptions.ts` | All callers — every method throws subclasses of `SatimError`. |
| `types.ts` | Public API surface. Breaking changes require coordinated updates in `config.ts`, `responses/`, `Satim.ts`. |
| `money.ts` | Currency arithmetic correctness across `validation.ts`, `Satim.ts`, `responses/confirm.ts`, `idempotency.ts`. Adversarial tests in `tests/math-precision.test.ts` and `tests/adversarial.test.ts` cover the boundary. |
| `ssrf.ts` | URL acceptance policy for `returnUrl`, `failUrl`, `dynamicCallbackUrl`. Tightening rules may reject inputs that previously passed. |
| `validation.ts` | Setter rejection thresholds. Loosening any validator weakens defence-in-depth against malformed gateway input. |
| `config.ts` | Credential isolation invariants. The `WeakMap` and `clone()` mechanics must not be replaced with naive field copying. |
| `client.ts` | Retry semantics (adding retries to a mutation endpoint risks duplicate charges) and breaker accounting (every request path must report exactly one success or failure). |
| `circuit-breaker.ts` | Failure isolation. Removing the single-probe constraint enables thundering-herd recovery; removing the abandoned-probe timeout lets one unreported probe wedge the breaker permanently. |
| `responses/confirm.ts` | The mutual-exclusivity predicate contract. Adding a new predicate requires updating the dependency chain comment and every other predicate's exclusion list. |
| `webhook/handler.ts` | Webhook idempotency and amount-verification guarantees. Widening `isTerminal` beyond deposited/refunded/reversed causes paid orders to be reported as duplicates and never fulfilled. |
| `Satim.ts` | All endpoint behaviour. The `validateForRegister`, `buildData`, and `safeRegisterAt` helpers are the only places the credential store is read. |

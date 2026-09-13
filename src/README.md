# src

Source root. System level design is in [ARCHITECTURE.md](../ARCHITECTURE.md).

## Responsibility

Implement the SATIM REST client, gateway response wrappers, immutable fluent
configuration, and the zero trust webhook handler. No runtime dependencies, no `node:`
imports: the package uses Web standard globals only, so it loads unmodified on edge runtimes.

## Module map

Dependency order. A module imports only from modules above it.

| Module | Responsibility |
| - | - |
| [`exceptions.ts`](./exceptions.ts) | `SatimError` hierarchy, `SatimErrorCategory`, message sanitiser |
| [`types.ts`](./types.ts) | `SatimCredentials`, `Language`, `CurrencyCode`, gateway payload interfaces |
| [`crypto.ts`](./crypto.ts) | `sha256Hex`, `sha256Bytes`, `randomOrderNumber`, `hexToBase36`. In tree FIPS 180-4 SHA-256 and CSPRNG, replacing `node:crypto` |
| [`money.ts`](./money.ts) | `toMinorUnits`, `hasSubCentimePrecision`, `isWholeMinorUnits`, `MAX_SAFE_AMOUNT` |
| [`idempotency.ts`](./idempotency.ts) | `deriveIdempotencyKey`, `deriveOrderNumber`. Deterministic SHA-256 derivations |
| [`ssrf.ts`](./ssrf.ts) | `assertSafeUrl`, `isPrivateHost`. Private range, internal hostname and encoding rejection |
| [`validation.ts`](./validation.ts) | Pure field validators for every setter and endpoint argument |
| [`config.ts`](./config.ts) | `SatimConfig`. Module private `WeakMap` credential store, immutable fluent setters |
| [`circuit-breaker.ts`](./circuit-breaker.ts) | `CircuitBreaker`. CLOSED/OPEN/HALF_OPEN with single probe recovery |
| [`client.ts`](./client.ts) | `HttpClientService`. Form encoded POST, retry loop, request coalescing, gateway error translation |
| [`responses/`](./responses/README.md) | `RegisterResponse`, `ConfirmResponse`, schema validators |
| [`webhook/`](./webhook/README.md) | Callback handler, checksum verification, extraction, rate limiter |
| [`Satim.ts`](./Satim.ts) | Public facade. Extends `SatimConfig`, owns the HTTP client, exposes endpoint methods |
| [`index.ts`](./index.ts) | Public barrel |

## Compatibility shims

Re-export only, no logic. They preserve import paths from before the directory split.

| Shim | Re-exports from |
| - | - |
| [`utils.ts`](./utils.ts) | `money.ts`, `idempotency.ts` |
| [`responses.ts`](./responses.ts) | `responses/register.ts`, `responses/confirm.ts` |
| [`webhook.ts`](./webhook.ts) | `webhook/handler.ts`, `webhook/checksum.ts` |

Consumers import from the package root: `import { Satim } from "satim-sdk"`.

## Platform dependencies

`package.json` declares no runtime dependencies. `devDependencies` cover the TypeScript
compiler, TypeDoc and the test runner only.

| Global | Used by | Purpose |
| - | - | - |
| `fetch` | `client.ts` | HTTP transport |
| `AbortController` | `client.ts` | per attempt timeout. Aborts are detected by error `name`, not `instanceof DOMException`, so a custom `fetch` classifies correctly |
| `URL`, `URLSearchParams` | `client.ts`, `ssrf.ts`, `webhook/extract.ts` | URL parsing, form body encoding |
| `TextEncoder`, `TextDecoder` | `crypto.ts`, `webhook/checksum.ts`, `client.ts` | UTF-8 encoding, capped response decoding |
| `crypto.getRandomValues` | `crypto.ts` | CSPRNG for default order numbers. SHA-256 is in tree so it stays synchronous; `crypto.subtle` is async |
| `structuredClone` | `responses/register.ts`, `responses/confirm.ts` | detach gateway payloads at the SDK boundary |
| `Response` | `responses/register.ts` | `redirectResponse()` |
| `console.warn` | `webhook/handler.ts` | multi instance and unchecked signature warnings |
| `process.env` | `client.ts` | read only, guarded by a `typeof process` check, for the TLS guard |

## Blast radius

| Editing | Affects |
| - | - |
| `exceptions.ts` | every caller; all methods throw `SatimError` subclasses |
| `types.ts` | public API surface. Changes require coordinated edits in `config.ts`, `responses/`, `Satim.ts` |
| `crypto.ts` | idempotency keys, derived order numbers, callback signature verification, request coalescing keys. Any digest change invalidates every previously derived key |
| `money.ts` | currency correctness across `validation.ts`, `Satim.ts`, `responses/confirm.ts`, `idempotency.ts`. Boundary coverage lives in `tests/math-precision.test.ts` and `tests/adversarial.test.ts` |
| `ssrf.ts` | URL acceptance for `returnUrl`, `failUrl`, `dynamicCallbackUrl`, and the HTTP `baseUrl` decision. Tightening may reject inputs that previously passed |
| `validation.ts` | setter rejection thresholds. Loosening a validator weakens defence in depth |
| `config.ts` | credential isolation. The `WeakMap` and the explicit field copy in `clone()` must not be replaced with naive field copying or `Object.assign` |
| `client.ts` | retry semantics (adding retries to a mutation risks duplicate charges) and breaker accounting (every path must report exactly one outcome) |
| `circuit-breaker.ts` | failure isolation. Removing the single probe rule enables thundering herd recovery; removing the abandoned probe timeout lets one unreported probe wedge the breaker permanently |
| `responses/confirm.ts` | the mutual exclusivity contract. A new predicate requires updating the known status set and every later predicate in the chain |
| `webhook/handler.ts` | callback idempotency and amount guarantees. Widening the terminal state set causes paid orders to be reported as duplicates and never fulfilled |
| `Satim.ts` | all endpoint behaviour. `validateForRegister`, `buildData` and `safeRegisterAt` are the only readers of the credential store |

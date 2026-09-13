# satim-sdk

TypeScript client for the SATIM payment gateway (CIB and Edahabia cards, Algeria).
Zero runtime dependencies. Web-standard globals only. Strict TypeScript.

[![CI](https://github.com/z3rco/satim-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/z3rco/satim-sdk/actions/workflows/ci.yml) [![CodeQL](https://github.com/z3rco/satim-sdk/actions/workflows/codeql.yml/badge.svg)](https://github.com/z3rco/satim-sdk/actions/workflows/codeql.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE.md) [![API Docs](https://img.shields.io/badge/docs-TypeDoc-blueviolet)](https://z3rco.github.io/satim-sdk/)

> [!WARNING]
> Never exercised against the live SATIM production gateway. Validated only against
> the test gateway (`test2.satim.dz`) and simulated responses. Production use is at
> your own risk; the authors accept no liability for payment failures, data loss, or
> financial loss. Run your own end to end test pass against the test gateway first.

## 1. Scope

In scope:

- Order registration (`/register.do`, `/registerPreAuth.do`) and hosted form redirect.
- Order lifecycle: acknowledge, status, extended status, deposit, refund, reverse, decline.
- Terminal capability probing.
- Zero trust callback handling (signature verification plus live state re-fetch).

Out of scope (not exposed by the SATIM deployment; see [docs/ENDPOINTS.md](./docs/ENDPOINTS.md)):

- Card bindings and tokenized payments.
- Wallet payments (Apple, Google, Samsung).
- Recurring and installment payments.
- 3-D Secure step handling. The hosted form owns it.

## 2. Runtime requirements

Required globals: `fetch`, `AbortController`, `URL`, `URLSearchParams`, `TextEncoder`,
`TextDecoder`, `structuredClone`, `crypto.getRandomValues`, `Response`.
No `node:` imports. No polyfill or compatibility flag needed on any runtime below.

| Runtime | Minimum | Notes |
| - | - | - |
| Node.js | 20 | `type: module` package, ESM only |
| Bun | 1.0 | |
| Deno | 1.28 | |
| Cloudflare Workers | any | `nodejs_compat` NOT required |
| Vercel / Netlify Edge | any | |

## 3. Install

```bash
npm install satim-sdk
bun add satim-sdk
pnpm add satim-sdk
```

## 4. Quick start

```typescript
import { Satim } from 'satim-sdk';

const satim = new Satim({
  username: process.env.SATIM_USERNAME!,
  password: process.env.SATIM_PASSWORD!,
  terminalId: process.env.SATIM_TERMINAL_ID!,
});

const payment = await satim
  .amount(1500)                                  // major units, whole dinars, >= 50
  .returnUrl('https://your-app.com/callback')
  .register();

return payment.redirectResponse();               // Web API Response, HTTP 302
```

Verification is server side and mandatory. Redirect query parameters are not proof of payment.

```typescript
const response = await satim.confirm(orderId, expectedCartTotal);

if (response.isSuccessful()) { /* amount already verified, safe to fulfil */ }
else if (response.isPending()) { /* still in flight, do not fulfil, poll later */ }
else if (response.isPreAuthorized()) { /* funds held, call deposit() to capture */ }
else { /* response.getErrorMessage() */ }
```

## 5. Client API

Base URL: `https://cib.satim.dz/payment/rest`. With `setTestMode(true)`:
`https://test2.satim.dz/payment/rest`. Every call is a form encoded POST carrying
`userName` and `password`.

| Method | Endpoint | Mutating | Retried on transient failure | Returns |
| - | - | - | - | - |
| `register()` | `/register.do` | yes | only when an idempotency key is set | `RegisterResponse` |
| `registerPreAuth()` | `/registerPreAuth.do` | yes | only when an idempotency key is set | `RegisterResponse` |
| `safeRegister(ref)` | `/register.do` | yes | yes (key derived from `ref`) | `RegisterResponse` |
| `safeRegisterPreAuth(ref)` | `/registerPreAuth.do` | yes | yes (key derived from `ref`) | `RegisterResponse` |
| `confirm(orderId, expected)` | `/public/acknowledgeTransaction.do` | yes | no | `ConfirmResponse` |
| `status(orderId)` | `/getOrderStatus.do` | no | yes | `ConfirmResponse` |
| `statusExtended(orderId)` | `/getOrderStatusExtended.do` | no | yes | `ConfirmResponse` |
| `statusAll(orderIds[])` | `/getOrderStatus.do` per id | no | yes | `ConfirmResponse[]` |
| `deposit(orderId, amount?)` | `/deposit.do` | yes | no | `ConfirmResponse` |
| `refund(orderId, amount)` | `/refund.do` | yes | no | `ConfirmResponse` |
| `reverseOrder(orderId)` | `/reverse.do` | yes | no | `ConfirmResponse` |
| `decline(orderId, orderNumber)` | `/decline.do` | yes | no | `ConfirmResponse` |
| `checkCapabilities()` | probes 6 endpoints | no | no | `SatimCapabilities` |
| `warmup()` | `/getOrderStatus.do` | no | no | `void`, never throws |
| `createWebhookHandler(opts)` | local | no | n/a | `WebhookHandler` |

Semantics that are not obvious from the signature:

- `confirm()` calls `verifyAmount(expected)` on a successful response. There is no opt out.
  It also rejects a settled `currency` that differs from the configured one.
- `confirm()` acknowledges the transaction. It is a mutation, never retried, never
  used on a replayed callback. Use `status()` to re-read.
- `status()` does NOT verify the amount. Call `verifyAmount()` yourself before acting on it.
- `deposit(orderId)` with no amount sends `amount=0`, which BPC reads as "capture the full order".
- `decline()` cancels an order that was never paid, and requires the order number, not just the id.
- `safeRegister(ref)` derives both the idempotency key and the order number from `ref`.
  A gateway duplicate verdict (`ErrorCode 1`) is translated to `SatimDuplicateOrderError`;
  recover with `status()` on the original order id.

## 6. Configuration

`SatimConfig` is immutable. Every setter clones the instance, mutates the clone, and
returns it. A base instance is safe to share across concurrent requests.

```typescript
const base = new Satim(creds).setTestMode(true).language('FR');
const a = base.amount(1500).returnUrl(urlA);   // base is unchanged
const b = base.amount(9900).returnUrl(urlB);   // a is unchanged
```

| Setter | Wire field | Constraint, violation throws `SatimInvalidArgumentError` |
| - | - | - |
| `amount(n)` | `amount` | number, finite, > 0, <= 9999999999.99, <= 2 decimals, >= 5000 centimes (50 DZD), multiple of 100 centimes |
| `returnUrl(url)` | `returnUrl` | http/https, passes the SSRF guard |
| `failUrl(url)` | `failUrl` | http/https, passes the SSRF guard. Defaults to `returnUrl` |
| `description(text)` | `description` | string, <= 600 chars, no `<` or `>` |
| `language(lang)` | `language` | `"FR"`, `"AR"`, `"EN"`. Default `"FR"` |
| `currency(code)` | `currency` | `"DZD"` (012), `"USD"` (840), `"EUR"` (978). Default DZD |
| `orderNumber(n)` | `orderNumber` | 1 to 10 alphanumeric chars (SATIM AN.10). Default: random 10 char base36 |
| `timeout(seconds)` | `sessionTimeoutSecs` | integer, 600 to 86400 |
| `userDefinedField(k, v)` | `jsonParams` | key non empty, non numeric, <= 128 chars, not reserved; value string <= 20 chars |
| `userDefinedFields(obj)` | `jsonParams` | applies `userDefinedField` per entry |
| `dynamicCallbackUrl(url)` | `dynamicCallbackUrl` | http/https, passes the SSRF guard |
| `idempotencyKey(key)` | `externalRequestId` | 1 to 128 chars of `[A-Za-z0-9_-]` |
| `setTestMode(bool)` | n/a | rebuilds the HTTP client unless a custom one was injected |
| `allowPrivateUrls(bool)` | n/a | development only, see section 14 |

Reserved `jsonParams` keys, rejected at setter time: `force_terminal_id`, `__proto__`,
`constructor`, `prototype`.

Credential constraints, enforced in the `Satim` constructor: all three fields are strings,
trimmed non empty; `username` and `password` <= 100 chars; `terminalId` <= 16 chars.
Credentials cannot be re-set on an instance.

`register()` and `registerPreAuth()` additionally require `returnUrl` and `amount`.
Missing either throws `SatimMissingDataError`.

## 7. Responses

### 7.1 RegisterResponse

| Method | Returns | Notes |
| - | - | - |
| `getOrderId()` | `string` | gateway order id |
| `getUrl()` | `string` | hosted form URL. Enforces HTTPS and a hostname in `{satim.dz, cib.satim.dz, test.satim.dz, test2.satim.dz}` |
| `redirectResponse()` | `Response` | HTTP 302 to `getUrl()`, same allowlist |
| `getRawResponse()` | `RegisterOrderResponse` | shallow copy, no PII fields exist on this payload |

### 7.2 ConfirmResponse accessors

| Method | Returns | Notes |
| - | - | - |
| `getAmount()` | `number \| undefined` | major units. `undefined` if non integer minor units or above `Number.MAX_SAFE_INTEGER` |
| `getDepositAmount()` | `number \| undefined` | same rules, captured amount |
| `getOrderNumber()` | `string \| undefined` | `OrderNumber` then `orderNumber` |
| `getApprovalCode()` | `string \| undefined` | issuer approval code |
| `getCardPan()` | `string \| undefined` | masked PAN |
| `getCardHolderName()` | `string \| undefined` | |
| `getCardExpiry()` | `string \| undefined` | `YYYYMM` |
| `getIpAddress()` | `string \| undefined` | cardholder IP |
| `getSuccessMessage()` | `string` | falls back to `getErrorMessage()` when not successful |
| `getErrorMessage()` | `string` | |
| `verifyAmount(expected)` | `void` | throws `SatimUnexpectedResponseError` on mismatch |
| `getRawResponse()` | `Record<string, unknown>` | shallow copy with `Ip`, `Pan`, `cardholderName`, `expiration` replaced by `"[REDACTED]"` |

### 7.3 Status predicates

Exactly one of the ten predicates returns `true` for any well formed response.

| Predicate | Condition |
| - | - |
| `isPending()` | `OrderStatus` in {`0` registered, `5` 3-D Secure running, `7` pending payment} |
| `isPreAuthorized()` | `OrderStatus == 1`, funds held, awaiting `deposit()` |
| `isSuccessful()` | `OrderStatus == 2`, authorized and captured |
| `isReversed()` | `OrderStatus == 3`, authorization voided |
| `isRefunded()` | `OrderStatus == 4` |
| `isRejected()` | `OrderStatus == 6`, or no known status plus a decline signal (`actionCode` 2003 or 111, `params.respCode` not in {"", "00"}, or an English "payment is declined" message) |
| `isPartiallyCaptured()` | `OrderStatus == 8`, multi part capture in progress |
| `isExpired()` | no known status, `actionCode == -2007` |
| `isCancelled()` | no known status, not expired, error signal present, `actionCode == 10` or an English "payment is cancelled" message |
| `isFailed()` | catch all: no known status and none of the composites matched |

`isPending()`, `isPreAuthorized()` and `isPartiallyCaptured()` are in flight states.
Treating them as failure invites a merchant to cancel or re-charge a live order.

## 8. Amount handling

All gateway amounts are integer minor units (centimes). The SDK converts through one
function, `toMinorUnits`, and never by ad hoc float arithmetic.

| Rule | Value |
| - | - |
| Conversion | `Math.round(amount * 100)` behind a precision guard |
| Precision guard | reject if `abs(amount*100 - round(amount*100)) > max(1e-7, abs(round(amount*100)) * 1e-13)` |
| Upper bound | `MAX_SAFE_AMOUNT = 9999999999.99` |
| Lower bound | result must be >= 1 minor unit |
| Registration floor | 5000 minor units (50 DZD), SATIM rule |
| Registration granularity | multiple of 100 minor units (whole dinars), SATIM rule |
| Reverse conversion | `parseFloat((minor / 100).toFixed(2))`, `undefined` above `Number.MAX_SAFE_INTEGER` |
| Gateway amount parsing | accepts `"5000"` and `"5000.00"`, rejects genuinely fractional minor units |

`refund()` and `deposit()` use the general rule (>= 1 minor unit); the 50 DZD floor and
whole dinar granularity apply to registration only.

## 9. Idempotency

```typescript
const res = await satim.amount(1500).returnUrl(url).safeRegister('cart-42');
```

- `deriveIdempotencyKey({merchantRef, amount, currency, mode})` returns
  `dk_<sha256 hex>` over `mode|merchantRef|minorUnits|currency`. Sent as `externalRequestId`.
- `deriveOrderNumber(merchantRef, currency, mode)` returns 10 base36 chars over
  `ordnum|mode|merchantRef|currency`. Space is 36^10; the 50 percent birthday point is
  near 60 million derived references.
- A change of amount or currency changes the key, so a re-priced cart is a new order.
- Registration is retried on transient failure only when a key is present, because the
  gateway then deduplicates instead of creating a second order.

## 10. Webhooks

SATIM delivers notifications as query parameters on `dynamicCallbackUrl`, keyed
`mdOrder` (not `orderId`). Payloads are treated as untrusted: the handler uses them only
to learn which order to re-read, then fetches authoritative state from the gateway.

```typescript
const handler = satim.createWebhookHandler({
  // Exactly one of these two is required; constructing with neither throws.
  callbackSecret: process.env.SATIM_CALLBACK_SECRET,
  // allowUnverifiedCallbacks: true,

  onResolveAmount: (orderId) => db.orders.findByGatewayId(orderId)?.totalDZD,

  // Multi instance deployments MUST back these with a shared atomic store.
  onCheckDuplicate: (orderId) => redis.exists(`satim:done:${orderId}`),
  onMarkProcessed: (orderId) => redis.set(`satim:done:${orderId}`, '1'),
});

app.post('/satim/callback', async (req, res) => {
  const outcome = await handler.inspect(req.query);

  if (!outcome.verified) {
    // Status selection matters: 200 tells SATIM the callback was handled and it
    // will never redeliver, which silently drops a real payment notification.
    return res.sendStatus({
      invalid_source: 400,
      bad_signature: 400,
      rate_limited: 429,
      unknown_order: 404,
    }[outcome.reason]);
  }

  const { orderId, response, duplicate } = outcome.result;
  if (response.isSuccessful() && !duplicate) await fulfilOrder(orderId);
  res.sendStatus(200);
});
```

| Option | Default | Constraint |
| - | - | - |
| `onResolveAmount` | required | returns expected major units, or nullish for an unknown order |
| `callbackSecret` | none | required unless `allowUnverifiedCallbacks: true` |
| `allowUnverifiedCallbacks` | `false` | required unless `callbackSecret` is set |
| `onCheckDuplicate` | in memory `Set` | must be atomic with the mark step across instances |
| `onMarkProcessed` | in memory `Set`, bounded at 10000 entries | |
| `maxCallbacksPerWindow` | 100 | integer >= 1, per handler instance, counts all orders |
| `rateLimitWindowMs` | 60000 | integer >= 1000 |
| `suppressMultiInstanceWarning` | `false` | silences the in memory fallback warning |

- `inspect(source)` returns `{verified: true, result}` or `{verified: false, reason}` where
  `reason` is `invalid_source`, `bad_signature`, `rate_limited`, or `unknown_order`.
- `verify(source)` is the lossy form: it collapses all four rejections to `null`.
  Prefer `inspect()` wherever the HTTP status matters.
- An order is marked processed only on a terminal state: captured (2), refunded (4),
  reversed (3). Pre-authorized holds, declines and expiries stay unmarked, so a later
  capture or a successful card retry still arrives with `duplicate: false`.
- A signature proves origin, not freshness. A replayed notification carries a valid one.
  Both checks run; neither replaces the other.

## 11. Terminal capabilities

BPC order management operations are enabled per merchant. `deposit`, `refund`, `reverse`
and `decline` may be deployed on the gateway and still closed to your terminal.

```typescript
const caps = await satim.checkCapabilities();
// { credentialsValid: true,
//   operations: { status: 'available', statusExtended: 'available',
//                 deposit: 'available', refund: 'not_permitted',
//                 reverse: 'not_permitted', decline: 'available' } }
```

Each operation is probed with an order id that cannot exist, so nothing is mutated; the
gateway can only answer with a permission verdict. If the control probe shows the
credentials are rejected, `credentialsValid` is `false` and every operation reads
`unknown`, because a bad password denies everything and proves nothing about entitlement.

Run at startup or as a deployment smoke test. Six requests per call; not for the request path.

## 12. Errors

Every error extends `SatimError`.

| Class | Raised when | Extra fields |
| - | - | - |
| `SatimMissingDataError` | required field not set (`returnUrl`, `amount`, `onResolveAmount`, callback secret choice) | |
| `SatimInvalidArgumentError` | validation failure at a setter, or gateway `ErrorCode 6` (invalid order id) | |
| `SatimInvalidCredentialsError` | HTTP 401/403, or gateway `ErrorCode 5`. On a permission gated endpoint the message says the terminal may simply not be entitled | |
| `SatimGatewayError` | gateway `ErrorCode` 1, 3, 4, 7 | `errorCode`, `errorMessage` |
| `SatimDuplicateOrderError` | `safeRegister` hit `ErrorCode 1` | `merchantRef` (sanitized) |
| `SatimUnexpectedResponseError` | transport, parse, HTTP, circuit, or unclassified gateway failure | `errorCategory`, `isTimeout`, `httpStatus`, `gatewayErrorCode`, `gatewayErrorMessage` |

`ErrorCode` mapping: `0` none, `1` duplicate order, `3` unknown currency, `4` missing
parameter, `5` access denied, `6` invalid order id, `7` system error, anything else
becomes `SatimUnexpectedResponseError` with `errorCategory: "gateway"`.

`SatimErrorCategory` is `"network" | "timeout" | "parse" | "http" | "gateway" |
"circuit_open" | "unknown"`. Gateway messages are stripped of non printable bytes and
truncated to 200 characters before they reach any error message.

## 13. Transport

`new Satim(credentials, options)` accepts `HttpClientOptions` or an `HttpClientService` instance.

| Option | Default | Constraint |
| - | - | - |
| `maxRetries` | 2 | clamped to 0 to 10 |
| `timeoutMs` | 30000 | 1000 to 300000, per attempt |
| `circuitBreaker` | `{failureThreshold: 5, resetTimeoutMs: 30000}` | `false` disables it |
| `fetch` | `globalThis.fetch` | custom implementation, for example an undici `Pool` |
| `baseUrl` | gateway URL for the current mode | must be HTTPS unless the host is private |

Behaviour:

- Backoff is `500ms * 2^attempt` plus 0 to 50 percent jitter. Maximum total backoff at
  defaults is about 2.25 seconds.
- Retried: timeouts, connection level failures, HTTP 5xx. Never retried: HTTP 4xx,
  malformed payloads, an open circuit.
- Concurrent identical retryable requests are coalesced on a key of
  `endpoint + sha256(form body)`. Non retryable calls are never coalesced.
- Circuit breaker states are CLOSED, OPEN, HALF_OPEN. Five consecutive transient
  failures open it; after 30 seconds one probe is admitted; success closes it, failure
  re-opens it with a fresh timer. A probe whose outcome is never reported is treated as
  abandoned after the reset timeout.
- 4xx responses do not count toward opening the circuit. A local `NODE_TLS_REJECT_UNAUTHORIZED=0`
  fault is checked before the breaker gate and counts as neither failure nor probe.
- Response bodies are streamed with a hard 1 MiB cap.
- Every request carries `Cache-Control: no-store, no-cache` and `Pragma: no-cache`.

## 14. Security invariants

| ID | Invariant |
| - | - |
| S1 | Credentials live in a module private `WeakMap`. They are not own properties and never appear in `Object.keys`, `JSON.stringify`, `console.log`, or prototype traversal. Serializers return `[REDACTED]` |
| S2 | `force_terminal_id` is stripped from caller supplied `jsonParams` and re-injected from the credential store on every registration |
| S3 | All caller URLs are checked against private and reserved IPv4/IPv6 ranges, known internal hostnames, and non standard IP encodings (decimal, octal, hex) |
| S4 | The hosted form URL is accepted only over HTTPS and only for a known `satim.dz` hostname, on both `getUrl()` and `redirectResponse()` |
| S5 | Mutating calls (`confirm`, `deposit`, `refund`, `reverseOrder`, `decline`) are never retried |
| S6 | `confirm()` verifies the settled amount and currency on success, with no opt out |
| S7 | Requests are refused outright when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set |
| S8 | Callback checksums are verified with constant time comparison before any gateway call |
| S9 | Callbacks with duplicate query keys are rejected, closing the parser differential replay |
| S10 | PII (`Ip`, `Pan`, `cardholderName`, `expiration`) is redacted in `ConfirmResponse.getRawResponse()` |

Operator requirements:

1. Verify server side. Redirect parameters are attacker controlled.
2. Never log raw request or response bodies. Every POST body carries the merchant password.
3. Load credentials from the environment or a secret manager, never from source.
4. Keep TLS verification on. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
5. In multi instance deployments, make the webhook duplicate check and mark atomic.

`allowPrivateUrls(true)` disables the private range checks for that instance only. It
still rejects obfuscated IP encodings, and validated private URLs are never cached.
It is a development affordance; enabling it in production re-opens the SSRF surface.

Full threat model and residual risks: [SECURITY.md](./SECURITY.md).

## 15. Development

```bash
bun install       # dev dependencies
bun test          # unit suite (vitest)
npm run typecheck # strict tsc, no emit
npm run build     # compile to dist/
npm run smoke     # load dist/ in plain Node, assert the public surface
npm run docs      # TypeDoc into docs/api/
```

## 16. Document map

| Document | Content |
| - | - |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | layering, request lifecycle, invariants, state machines |
| [SECURITY.md](./SECURITY.md) | threat model, controls, known limitations |
| [docs/ENDPOINTS.md](./docs/ENDPOINTS.md) | probed endpoint inventory for the SATIM deployment |
| [src/README.md](./src/README.md) | module map, dependency order, blast radius |
| [src/responses/README.md](./src/responses/README.md) | response wrappers, predicate contract |
| [src/webhook/README.md](./src/webhook/README.md) | callback verification flow |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | rules for changes |
| [CHANGELOG.md](./CHANGELOG.md) | released and unreleased changes |

## License

MIT. See [LICENSE.md](./LICENSE.md).

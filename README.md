<div align="center">

# satim-sdk

**The stateless, secure, zero-dependency TypeScript SDK for the [SATIM](https://www.satim.dz/) payment gateway.**

CIB and Edahabia card payments for Algeria — production-grade, runtime-agnostic, security-first.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE.md)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](#compatibility)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-success)](./package.json)
[![Tests](https://img.shields.io/badge/tests-vitest-6E4AFF)](./tests)

</div>

---

## Why satim-sdk?

- **Zero runtime dependencies.** Just the Web Fetch API. No transitive supply chain.
- **Runs everywhere fetch runs.** Node 20+, Bun, Deno, Cloudflare Workers, Vercel Edge.
- **Strictly immutable, fluent API.** Every setter returns a new instance — no cross-request state leaks.
- **Security in depth by default.** SSRF guards, credential isolation in a module-private `WeakMap`, terminal-ID injection prevention, IEEE 754-safe currency conversion, and a deliberately conservative retry policy that never double-charges.
- **Typed gateway errors.** Discriminated `SatimError` subclasses with localized messages and a sanitized raw payload for logs (PII redacted).
- **Zero-trust webhooks.** Built-in HMAC verification, replay protection, and rate limiting — designed for distributed deployments.
- **Strict TypeScript.** Full type coverage, no `any` escape hatches in the public API.

## Compatibility

| Runtime               | Version | Notes                   |
| --------------------- | ------- | ----------------------- |
| Node.js               | ≥ 20    | Native `fetch` required |
| Bun                   | ≥ 1.0   |                         |
| Deno                  | ≥ 1.28  |                         |
| Cloudflare Workers    | All     | Edge-runtime safe       |
| Vercel / Netlify Edge | All     |                         |

## Install

```bash
npm install satim-module
# or
bun add satim-module
# or
pnpm add satim-module
```

## Quick Start

```typescript
import { Satim } from 'satim-module';

const satim = new Satim({
  username: process.env.SATIM_USERNAME!,
  password: process.env.SATIM_PASSWORD!,
  terminalId: process.env.SATIM_TERMINAL_ID!,
});

// Register a payment
const payment = await satim
  .amount(1500)
  .returnUrl('https://your-app.com/callback')
  .register();

// Redirect the customer to the hosted payment page
return payment.redirectResponse(); // standard Web API Response (302)
```

## Verifying a Payment

```typescript
const response = await satim.confirm(orderId, expectedCartTotal);

if (response.isSuccessful()) {
  // Amount verification is automatic for successful payments
  console.log(response.getSuccessMessage());
} else if (response.isPending()) {
  console.log('Payment not yet completed');
} else if (response.isCancelled()) {
  console.log('Customer cancelled the payment');
} else if (response.isExpired()) {
  console.log('Payment session expired');
} else {
  console.log(response.getErrorMessage());
}
```

## API

### Core Methods

| Method                     | Endpoint              | Returns            | Description                           |
| -------------------------- | --------------------- | ------------------ | ------------------------------------- |
| `register()`               | `/register.do`        | `RegisterResponse` | Register a payment order.             |
| `confirm(orderId, amount)` | `/confirmOrder.do`    | `ConfirmResponse`  | Confirm and deposit a payment.        |
| `status(orderId)`          | `/getOrderStatus.do`  | `ConfirmResponse`  | Query the current status of an order. |
| `refund(orderId, amount)`  | `/refund.do`          | `ConfirmResponse`  | Refund a captured payment.            |
| `registerPreAuth()`        | `/registerPreAuth.do` | `RegisterResponse` | Hold funds without capturing.         |
| `reverseOrder(orderId)`    | `/reverse.do`         | `ConfirmResponse`  | Void a transaction before settlement. |

### Configuration (Fluent Immutable API)

_The configuration is strictly immutable. Calling a setter returns a NEW instance._

| Method                 | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `amount(n)`            | Payment amount in major currency units (e.g. DZD). |
| `returnUrl(url)`       | Redirect URL after payment.                        |
| `failUrl(url)`         | Redirect URL on failure (defaults to `returnUrl`). |
| `description(text)`    | Text shown on the payment page (max 598 chars).    |
| `language(lang)`       | Payment page language: `"FR"`, `"AR"`, or `"EN"`.  |
| `currency(code)`       | `"DZD"`, `"USD"`, or `"EUR"`.                      |
| `orderNumber(n)`       | Custom 10-digit order number.                      |
| `timeout(seconds)`     | Session timeout (600 – 86400).                     |
| `userDefinedFields()`  | Custom metadata forwarded in `jsonParams`.         |
| `dynamicCallbackUrl()` | Server-to-server webhook for status notifications. |
| `setTestMode(bool)`    | Route requests to `test.satim.dz`.                 |

### Status Predicates (on `ConfirmResponse`)

All predicates are **mutually exclusive** — at most one terminal-state predicate will return `true` for any given response.

| Method           | Condition                                                |
| ---------------- | -------------------------------------------------------- |
| `isSuccessful()` | Payment deposited (OrderStatus 2).                       |
| `isPending()`    | Registered but not yet paid (OrderStatus 0).             |
| `isReversed()`   | Authorization reversed/voided (OrderStatus 3).           |
| `isFailed()`     | Terminal failure (not successful, refunded, or pending). |
| `isRejected()`   | Declined by the issuing bank.                            |
| `isRefunded()`   | Refunded (OrderStatus 4).                                |
| `isCancelled()`  | Customer cancelled before completing.                    |
| `isExpired()`    | Session timed out (actionCode -2007).                    |

### Response Accessors

Available on `RegisterResponse` or `ConfirmResponse`:

| Method                | Available On     | Returns                                       |
| --------------------- | ---------------- | --------------------------------------------- |
| `getOrderId()`        | RegisterResponse | Order identifier                              |
| `getUrl()`            | RegisterResponse | Hosted payment form URL                       |
| `redirectResponse()`  | RegisterResponse | Web API 302 Response                          |
| `getIpAddress()`      | ConfirmResponse  | Cardholder IP                                 |
| `getCardHolderName()` | ConfirmResponse  | Name on card                                  |
| `getCardExpiry()`     | ConfirmResponse  | Expiration (YYYYMM)                           |
| `getCardPan()`        | ConfirmResponse  | Masked PAN                                    |
| `getApprovalCode()`   | ConfirmResponse  | Issuer approval code                          |
| `getAmount()`         | ConfirmResponse  | Payment amount captured                       |
| `getOrderNumber()`    | ConfirmResponse  | Verified order number                         |
| `verifyAmount(n)`     | ConfirmResponse  | Security assertion                            |
| `getSuccessMessage()` | ConfirmResponse  | Localized success text                        |
| `getErrorMessage()`   | ConfirmResponse  | Localized error text                          |
| `getRawResponse()`    | Both             | Sanitized raw gateway response (PII redacted) |

## Error Handling

All errors extend `SatimError` for unified catching:

```typescript
import { SatimError, SatimGatewayError } from 'satim-module';

try {
  await satim.register();
} catch (err) {
  if (err instanceof SatimGatewayError) {
    // Typed BPC gateway error with err.errorCode and err.errorMessage
    // Code 1 = Duplicate order, 3 = Unknown currency,
    // 4 = Missing parameter, 7 = System error
  }
  if (err instanceof SatimError) {
    // SatimMissingDataError        - required field not set
    // SatimInvalidArgumentError    - validation failure
    // SatimInvalidCredentialsError - wrong username/password/terminal
    // SatimUnexpectedResponseError - network or malformed response
    // SatimGatewayError            - typed BPC gateway errors (1,3,4,7)
  }
}
```

## Security

The SDK ships with the following protections enabled by default:

- **Credential isolation** — Credentials live in a module-private `WeakMap` and never appear as enumerable properties. `JSON.stringify()` and `console.log()` automatically redact them. (The SATIM API requires credentials as POST form parameters on every request — make sure reverse proxies, WAFs, and APM tools do not log raw request bodies.)
- **SSRF protection** — All URLs are validated against private IP ranges (IPv4/IPv6), cloud metadata endpoints, and non-standard IP encodings (decimal, octal, hex).
- **Terminal-ID injection prevention** — `force_terminal_id` is always set by the SDK and cannot be overridden via `userDefinedFields`.
- **IEEE 754-safe currency conversion** — Amounts are converted to minor units using `toPrecision(12)` to avoid floating-point drift. Sub-centime amounts that would round to zero are rejected. The precision guard caps at ~10 billion major units.
- **Safe retry policy** — Financial mutations (`register`, `confirm`, `refund`, `reverseOrder`) never retry on transient errors, preventing double-charges or double-refunds. Only idempotent queries (`status`) retry automatically.
- **Immutable API** — Every setter returns a new instance, preventing cross-request state leaks.

### Best practices

1. **Always verify server-side.** Never trust client-side redirect parameters. Use `confirm()` or `status()` to verify outcomes from your backend.
2. **Always verify amounts.** Call `verifyAmount()` to detect partial-payment manipulation.
3. **Use environment variables.** Never hardcode credentials. Load them from `process.env` or a secrets manager.
4. **Never log request bodies.** Outgoing POST bodies contain credentials; ensure logging middleware excludes them.
5. **Keep TLS valid.** Never set `NODE_TLS_REJECT_UNAUTHORIZED=0` in production.

For the full threat model, see [`SECURITY.md`](./SECURITY.md).

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system topology, request lifecycle, technical constraints, state machine, predicate contract.
- [`src/README.md`](./src/README.md) — module map and dependency order.
- [`src/responses/README.md`](./src/responses/README.md) — response wrappers and the status predicate contract.
- [`src/webhook/README.md`](./src/webhook/README.md) — zero-trust verification flow and distributed deployment notes.
- [`SECURITY.md`](./SECURITY.md) — threat model, mitigations, known limitations.
- **API reference** — generated locally with `npm run docs` (outputs to `docs/api/`).

## Development

```bash
bun install       # install dev dependencies
bun test          # run the unit test suite (vitest)
npm run typecheck # strict type checking (any runtime)
npm run build     # compile to dist/
npm run docs      # generate TypeDoc API reference
```

## Contributing

Contributions are welcome. Please open an issue first for anything beyond a small fix so we can align on scope. PRs should:

1. Keep the zero-dependency rule intact.
2. Pass `npm run typecheck` and the full test suite.
3. Include tests for behavioral changes.
4. Follow the existing immutable, fluent API style.

## License

Released under the [MIT License](./LICENSE.md).

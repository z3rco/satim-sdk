# NUMERIC

> *"Ancient engineers built invisible channels that moved water across the Sahara with no pumps, no friction. We do the same with payments."*

Proprietary, stateless TypeScript SDK for the [SATIM](https://www.satim.dz/) interbank payment gateway in Algeria. Zero runtime dependencies.

Supports **CIB** and **Edahabia** card payments through the official SATIM REST API.

## Compatibility

| Runtime    | Version  | Notes                   |
|------------|----------|-------------------------|
| Node.js    | >= 18    | Native `fetch` required |
| Bun        | >= 1.0   |                         |
| Deno       | >= 1.28  |                         |
| Cloudflare Workers | All |                      |

## Quick Start

```typescript
import { Satim } from "numeric";

const satim = new Satim({
    username: process.env.SATIM_USERNAME,
    password: process.env.SATIM_PASSWORD,
    terminalId: process.env.SATIM_TERMINAL_ID,
});

// Register a payment
const paymentResponse = await satim
    .amount(1500)
    .returnUrl("https://your-app.com/callback")
    .register();

// Redirect the customer to the hosted payment page
return paymentResponse.redirectResponse(); // standard Web API Response (302)
```

## Verifying a Payment

```typescript
const response = await satim.confirm(orderId, expectedCartTotal);

if (response.isSuccessful()) {
    // Amount verification is automatic for successful payments
    console.log(response.getSuccessMessage());
} else if (response.isPending()) {
    console.log("Payment not yet completed");
} else if (response.isCancelled()) {
    console.log("Customer cancelled the payment");
} else if (response.isExpired()) {
    console.log("Payment session expired");
} else {
    console.log(response.getErrorMessage());
}
```

## API

### Core Methods

| Method                       | Endpoint             | Returns                 | Description                            |
|------------------------------|----------------------|-------------------------|----------------------------------------|
| `register()`                 | `/register.do`       | `RegisterResponse`      | Register a payment order.              |
| `confirm(orderId, amount)`   | `/confirmOrder.do`   | `ConfirmResponse`       | Confirm and deposit a payment.         |
| `status(orderId)`            | `/getOrderStatus.do` | `ConfirmResponse`       | Query the current status of an order.  |
| `refund(orderId, amount)`    | `/refund.do`         | `ConfirmResponse`       | Refund a captured payment.             |
| `registerPreAuth()`          | `/registerPreAuth.do`| `RegisterResponse`      | Hold funds without capturing.          |
| `reverseOrder(orderId)`      | `/reverse.do`        | `ConfirmResponse`       | Void a transaction before settlement.  |

### Configuration (Fluent Immutable API)

*The configuration is strictly immutable. Calling a setter returns a NEW instance.*

| Method                | Description                                         |
|-----------------------|-----------------------------------------------------|
| `amount(n)`           | Payment amount in major currency units (e.g. DZD).  |
| `returnUrl(url)`      | Redirect URL after payment.                         |
| `failUrl(url)`        | Redirect URL on failure (defaults to `returnUrl`).  |
| `description(text)`   | Text shown on the payment page (max 598 chars).     |
| `language(lang)`      | Payment page language: `"FR"`, `"AR"`, or `"EN"`.   |
| `currency(code)`      | `"DZD"`, `"USD"`, or `"EUR"`.                       |
| `orderNumber(n)`      | Custom 10-digit order number.                       |
| `timeout(seconds)`    | Session timeout (600 - 86400).                      |
| `userDefinedFields()` | Custom metadata forwarded in `jsonParams`.           |
| `dynamicCallbackUrl()`| Server-to-server webhook for status notifications.  |
| `setTestMode(bool)`   | Route requests to `test.satim.dz`.                  |

### Status Predicates (Available on `ConfirmResponse`)

All predicates are **mutually exclusive** — at most one terminal-state predicate will return `true` for any given response.

| Method           | Condition                                          |
|------------------|----------------------------------------------------|
| `isSuccessful()` | Payment deposited (OrderStatus 2).                 |
| `isPending()`    | Registered but not yet paid (OrderStatus 0).       |
| `isReversed()`   | Authorization reversed/voided (OrderStatus 3).     |
| `isFailed()`     | Terminal failure (not successful, refunded, or pending). |
| `isRejected()`   | Declined by the issuing bank.                      |
| `isRefunded()`   | Refunded (OrderStatus 4).                          |
| `isCancelled()`  | Customer cancelled before completing.              |
| `isExpired()`    | Session timed out (actionCode -2007).              |

### Response Accessors

Available on `RegisterResponse` or `ConfirmResponse` objects:

| Method              | Available On     | Returns                |
|---------------------|------------------|------------------------|
| `getOrderId()`      | RegisterResponse | Order identifier       |
| `getUrl()`          | RegisterResponse | Hosted payment form URL|
| `redirectResponse()`| RegisterResponse | Web API 302 Response   |
| `getIpAddress()`    | ConfirmResponse  | Cardholder IP          |
| `getCardHolderName()`| ConfirmResponse | Name on card          |
| `getCardExpiry()`   | ConfirmResponse  | Expiration (YYYYMM)   |
| `getCardPan()`      | ConfirmResponse  | Masked PAN             |
| `getApprovalCode()` | ConfirmResponse  | Issuer approval code   |
| `getAmount()`       | ConfirmResponse  | Payment Amount captured|
| `getOrderNumber()`  | ConfirmResponse  | Verified Order Number  |
| `verifyAmount(n)`   | ConfirmResponse  | Security Assertion     |
| `getSuccessMessage()`| ConfirmResponse | Localized success text|
| `getErrorMessage()` | ConfirmResponse  | Localized error text   |
| `getRawResponse()`  | Both             | Sanitized raw gateway response (PII redacted) |

## Error Handling

All errors extend `SatimError` for unified catching:

```typescript
import { SatimError, SatimGatewayError } from "numeric";

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

## Testing

```bash
bun test         # unit tests (requires Bun)
npm run typecheck # strict type checking (any runtime)
npm run build     # compile to dist/
```

## Documentation

Detailed guides are available in [`docs/`](docs/):

1. [Installation](docs/01-installation.md)
2. [Initialization](docs/02-initialization.md)
3. [Registering a Payment](docs/03-creating-payment.md)
4. [Verifying a Payment](docs/04-verifying-payment.md)
5. [Refunds](docs/05-refunds.md)
6. [Advanced Features](docs/06-advanced-features.md)

## Architecture

```
numeric/
├── src/
│   ├── Satim.ts        # Main client class
│   ├── config.ts       # Configuration and fluent setters
│   ├── client.ts       # HTTP transport (Web Fetch API)
│   ├── types.ts        # TypeScript interfaces
│   ├── exceptions.ts   # Error hierarchy
│   ├── responses.ts    # Stateless response wrappers
│   ├── utils.ts        # Currency conversion helpers
│   ├── webhook.ts      # Zero-trust webhook handler
│   └── index.ts        # Barrel export
├── tests/
│   └── *.test.ts       # Unit tests
└── docs/               # Usage documentation
```

## Security

The SDK implements several security measures by default:

- **Credential isolation** — Credentials are stored in a module-private `WeakMap` and never appear as enumerable properties. `JSON.stringify()` and `console.log()` automatically redact them. Note: the SATIM API requires credentials as POST form parameters on every request — ensure your reverse proxies, WAFs, and APM tools do not log raw request bodies.
- **SSRF protection** — All URLs are validated against private IP ranges (IPv4/IPv6), cloud metadata endpoints, and non-standard IP encodings (decimal, octal, hex).
- **Terminal ID injection prevention** — The `force_terminal_id` parameter is always set by the SDK and cannot be overridden via `userDefinedFields`.
- **IEEE 754-safe currency conversion** — Amounts are converted to minor units using `toPrecision(12)` to avoid floating-point rounding errors. Sub-centime amounts that would round to zero are rejected. The precision guard caps at ~10 billion major units.
- **Safe retry policy** — Financial mutations (`register`, `confirm`, `refund`, `reverseOrder`) never retry on transient errors, preventing double-charges or double-refunds. Only idempotent queries (`status`) retry automatically.
- **Immutable API** — Every setter returns a new instance, preventing cross-request state leaks.

### Best practices

1. **Always verify server-side** — Never trust client-side redirect parameters. Use `confirm()` or `status()` to verify payment outcomes from your backend.
2. **Always verify amounts** — Call `verifyAmount()` to detect partial-payment manipulation.
3. **Use environment variables** — Never hardcode credentials. Load them from `process.env` or a secrets manager.
4. **Never log request bodies** — Outgoing POST bodies contain credentials; ensure your logging middleware excludes them.
5. **Keep TLS valid** — Never set `NODE_TLS_REJECT_UNAUTHORIZED=0` in production.

## License

UNLICENSED — Proprietary. All rights reserved.

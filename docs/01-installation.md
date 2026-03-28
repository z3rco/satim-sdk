# Installation

This guide walks you through installing the **satim-module** SDK and getting your environment ready to accept payments through the SATIM interbank gateway.

---

## What you're installing

**satim-module** is a TypeScript SDK that wraps the SATIM REST API — the payment gateway used by Algerian banks (CIB network). It handles authentication, request formatting, retries, error parsing, and payment verification so your application only needs to deal with business logic.

The package has **zero runtime dependencies**. Everything it needs (HTTP, cryptography, URL parsing) is available in the JavaScript runtimes it supports.

---

## Requirements

Before installing, make sure your environment meets these requirements:

| Requirement | Minimum version | Notes |
|---|---|---|
| Node.js | 18.0 | Required for the `fetch` global and Web Crypto APIs |
| Bun | 1.0 | Fully supported |
| Deno | 1.28 | Fully supported |
| TypeScript | 5.x | Strict mode recommended |
| Cloudflare Workers | Any | Supported via standard `fetch` |

> **Plain JavaScript is also supported.** TypeScript is recommended because the SDK uses type annotations to catch mistakes like passing the wrong type as an amount. In plain JavaScript those checks only happen at runtime.

---

## Installing the package

Run the command for your package manager:

```bash
# npm
npm install satim-module

# yarn
yarn add satim-module

# pnpm
pnpm add satim-module

# bun
bun add satim-module
```

This adds `satim-module` to your `dependencies` and downloads the package to `node_modules/`. The package ships pre-compiled JavaScript alongside TypeScript declaration files (`.d.ts`), so no build step is required on your end.

---

## Verifying the installation

After installing, confirm the package is available by importing the main class:

```typescript
import { Satim } from "satim-module";

console.log(typeof Satim); // "function"
```

If this runs without errors, the installation was successful.

---

## What gets exported

The `satim-module` package exports everything you need through a single entry point:

```typescript
import {
    // Main client
    Satim,

    // Error classes — use these in catch() blocks
    SatimError,
    SatimMissingDataError,
    SatimInvalidArgumentError,
    SatimInvalidCredentialsError,
    SatimUnexpectedResponseError,
    SatimGatewayError,
    SatimDuplicateOrderError,

    // Webhook handler
    WebhookHandler,

    // Utility functions (deterministic keys for idempotent payments)
    deriveIdempotencyKey,
    deriveOrderNumber,

    // Types (TypeScript only)
    type SatimCredentials,
    type WebhookHandlerOptions,
    type WebhookResult,
    type HttpClientOptions,
    type CircuitBreakerOptions,
} from "satim-module";
```

You do not need to import all of these. Most applications only need `Satim` and a few error classes.

---

## Next step

Once installed, proceed to [Initialization](02-initialization.md) to create your first client instance using your SATIM merchant credentials.

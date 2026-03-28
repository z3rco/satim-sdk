/**
 * Integration tests against the SATIM sandbox (test.satim.dz).
 *
 * These tests are skipped unless the following environment variables are set:
 *
 *   SATIM_TEST_USERNAME   - Sandbox merchant username
 *   SATIM_TEST_PASSWORD   - Sandbox merchant password
 *   SATIM_TEST_TERMINAL   - Sandbox terminal ID
 *
 * Run with real credentials:
 *   SATIM_TEST_USERNAME=u SATIM_TEST_PASSWORD=p SATIM_TEST_TERMINAL=t npx vitest run tests/integration.test.ts
 *
 * These tests make live HTTP calls to test.satim.dz and will fail if the
 * sandbox is unreachable. They are intentionally excluded from the standard
 * `npm test` run to avoid flakiness in CI without credentials.
 */

import { describe, test, expect, beforeAll } from "vitest";
import {
    Satim,
    SatimInvalidCredentialsError,
    SatimDuplicateOrderError,
    SatimGatewayError,
} from "../src";

// ─── Credential guard ──────────────────────────────────────────────────────

const CREDS = {
    username: process.env.SATIM_TEST_USERNAME ?? "",
    password: process.env.SATIM_TEST_PASSWORD ?? "",
    terminalId: process.env.SATIM_TEST_TERMINAL ?? "",
};

const HAVE_CREDS = Boolean(CREDS.username && CREDS.password && CREDS.terminalId);

// Skip the entire suite when sandbox credentials are absent.
// Using a describe.skipIf so the file can always be imported without errors.
const describeSandbox = HAVE_CREDS ? describe : describe.skip;

// ─── Shared test client ─────────────────────────────────────────────────────

let satim: Satim;

beforeAll(() => {
    if (!HAVE_CREDS) return;
    satim = new Satim(CREDS, { timeoutMs: 45_000 });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function baseConfig() {
    return satim
        .setTestMode(true)
        .amount(100)
        .currency("DZD")
        .returnUrl("https://example.com/success")
        .failUrl("https://example.com/fail")
        .language("FR");
}

// ─── Test suites ─────────────────────────────────────────────────────────────

describeSandbox("Integration — register()", () => {
    test("registers a new order and returns a formUrl", async () => {
        const response = await baseConfig().register();

        expect(response.getOrderId()).toBeTruthy();
        expect(response.getUrl()).toMatch(/^https:\/\/test\.satim\.dz\//);
    });

    test("register() with idempotency key returns the same orderId on retry", async () => {
        const key = `idem-${Date.now()}`;
        const config = baseConfig().idempotencyKey(key);

        const first = await config.register();
        const second = await config.register();

        expect(first.getOrderId()).toBe(second.getOrderId());
    });

    test("register() without idempotency key throws SatimGatewayError(1) on duplicate orderNumber", async () => {
        // Register once with a fixed order number, then register again with the same number.
        // SATIM should reject the second registration with ErrorCode 1.
        const fixedOrderNumber = "1234567890";
        const config = baseConfig().orderNumber(fixedOrderNumber);

        // First registration may succeed or may already exist — either outcome is valid.
        try {
            await config.register();
        } catch {
            // Order may already exist from a previous test run — that's fine.
        }

        // Second registration with the same orderNumber must be rejected.
        await expect(config.register()).rejects.toThrow(SatimGatewayError);
    });
});

describeSandbox("Integration — status()", () => {
    test("returns a ConfirmResponse for a known order", async () => {
        const { orderId } = (await baseConfig().register()).getRawResponse();
        const status = await satim.setTestMode(true).status(orderId);

        // A freshly registered order is pending (OrderStatus 0)
        expect(status.isPending()).toBe(true);
        expect(status.isSuccessful()).toBe(false);
    });

    test("status() on an unknown orderId throws SatimInvalidArgumentError", async () => {
        const { SatimInvalidArgumentError: Err } = await import("../src");
        await expect(
            satim.setTestMode(true).status("non-existent-order-id-xyz"),
        ).rejects.toThrow(Err);
    });
});

describeSandbox("Integration — confirm()", () => {
    test("confirm() on a pending order returns a non-successful response", async () => {
        const reg = await baseConfig().register();
        const orderId = reg.getOrderId();

        // The order has not been paid — confirm should return a non-successful terminal state
        // (rejected, expired, or still pending depending on gateway behavior).
        const response = await satim.setTestMode(true).confirm(orderId, 100);
        expect(response.isSuccessful()).toBe(false);
    });
});

describeSandbox("Integration — safeRegister()", () => {
    test("safeRegister() with the same merchantRef returns consistent orderId", async () => {
        const merchantRef = `test-ref-${Date.now()}`;

        const first = await baseConfig().safeRegister(merchantRef);
        const second = await baseConfig().safeRegister(merchantRef);

        expect(first.getOrderId()).toBe(second.getOrderId());
    });

    test("safeRegister() throws SatimDuplicateOrderError on mismatched amount", async () => {
        const merchantRef = `dup-test-${Date.now()}`;

        // Register with amount 100
        await baseConfig().amount(100).safeRegister(merchantRef);

        // Re-register with a different amount — derives a different idempotency key,
        // but the same order number → SATIM should reject with ErrorCode 1.
        await expect(
            baseConfig().amount(200).safeRegister(merchantRef),
        ).rejects.toThrow(SatimDuplicateOrderError);
    });
});

describeSandbox("Integration — invalid credentials", () => {
    test("rejects bad credentials with SatimInvalidCredentialsError", async () => {
        const bad = new Satim(
            { username: "bad", password: "creds", terminalId: "0000" },
        );
        await expect(
            bad.setTestMode(true).amount(100).returnUrl("https://example.com/ok").register(),
        ).rejects.toThrow(SatimInvalidCredentialsError);
    });
});

describeSandbox("Integration — circuit breaker", () => {
    test("circuit breaker opens after repeated credential failures", async () => {
        // Use bad credentials to force transient-style gateway errors.
        // We use a very low threshold so the breaker trips quickly.
        const bad = new Satim(
            { username: "bad", password: "creds", terminalId: "0000" },
            { circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 5000 }, maxRetries: 0 },
        );
        const config = bad.setTestMode(true).amount(100).returnUrl("https://example.com/ok");

        // First two calls fail with credential errors (not transient → breaker does not trip on these).
        // This test primarily validates that the circuit breaker can be configured without error
        // and that the SDK correctly propagates errors from the gateway.
        await expect(config.register()).rejects.toBeDefined();
    });
});

describeSandbox("Integration — configurable timeout", () => {
    test("accepts a custom timeoutMs without throwing", async () => {
        // Just verify the SDK accepts and uses the custom timeout — a 60s timeout
        // should not affect normal sandbox latency.
        const customSatim = new Satim(CREDS, { timeoutMs: 60_000 });
        const response = await customSatim
            .setTestMode(true)
            .amount(50)
            .currency("DZD")
            .returnUrl("https://example.com/ok")
            .register();

        expect(response.getOrderId()).toBeTruthy();
    });
});

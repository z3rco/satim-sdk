/**
 * Unit tests for hardening features:
 * 1. Circuit breaker
 * 2. Configurable HTTP timeout
 * 3. Multi-instance webhook deduplication warning
 * 4. Runtime typeof guards on amount / orderId inputs
 */

import { expect, test, describe, vi, beforeEach, afterEach } from "vitest";
import { Satim, SatimInvalidArgumentError, SatimUnexpectedResponseError } from "../src";
import { HttpClientService } from "../src/client";
import { WebhookHandler } from "../src/webhook";

// ─── 1. Circuit Breaker ──────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
    test("HttpClientService accepts circuitBreaker options", () => {
        expect(() => new HttpClientService(false, {
            circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 5000 },
        })).not.toThrow();
    });

    test("HttpClientService allows disabling circuit breaker with false", () => {
        expect(() => new HttpClientService(false, {
            circuitBreaker: false,
        })).not.toThrow();
    });

    test("Satim accepts circuitBreaker via options object", () => {
        expect(() => new Satim(
            { username: "u", password: "p", terminalId: "t" },
            { circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 10_000 } },
        )).not.toThrow();
    });

    test("circuit opens after threshold consecutive transient failures", async () => {
        const threshold = 3;
        const client = new HttpClientService(false, {
            maxRetries: 0,
            circuitBreaker: { failureThreshold: threshold, resetTimeoutMs: 60_000 },
        });

        // Simulate consecutive 503 responses to trip the breaker
        let callCount = 0;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockImplementation(async () => {
            callCount++;
            return { ok: false, status: 503, statusText: "Service Unavailable" };
        }) as typeof fetch;

        try {
            // Make exactly `threshold` calls to reach the failure threshold
            for (let i = 0; i < threshold; i++) {
                try {
                    await client.handleApiRequest("/register.do", { userName: "u", password: "p" });
                } catch {
                    // expected — each call fails with a 503
                }
            }

            // The next call should be rejected immediately by the open circuit (no fetch)
            const err = await client.handleApiRequest("/register.do", { userName: "u", password: "p" })
                .catch((e) => e);
            expect(err).toBeInstanceOf(SatimUnexpectedResponseError);
            expect((err as SatimUnexpectedResponseError).errorCategory).toBe("circuit_open");
            // No additional HTTP call was made — breaker blocked it
            expect(callCount).toBe(threshold);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("circuit resets to CLOSED after a successful request", async () => {
        const client = new HttpClientService(false, {
            maxRetries: 0,
            circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 0 }, // instant reset
        });

        let shouldSucceed = false;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockImplementation(async () => {
            if (shouldSucceed) {
                return {
                    ok: true,
                    text: async () => JSON.stringify({ ErrorCode: "0", orderId: "ok", formUrl: "https://x.com" }),
                };
            }
            return { ok: false, status: 503, statusText: "Service Unavailable" };
        }) as typeof fetch;

        try {
            // Trip the circuit
            for (let i = 0; i < 2; i++) {
                try { await client.handleApiRequest("/register.do", {}); } catch { /* expected */ }
            }

            // Wait for reset timeout (0ms) + small margin
            await new Promise((r) => setTimeout(r, 10));
            shouldSucceed = true;

            // Circuit should be HALF_OPEN now — probe request allowed through
            await client.handleApiRequest("/register.do", {});

            // Circuit should be CLOSED again — next request goes through normally
            shouldSucceed = true;
            await expect(client.handleApiRequest("/register.do", {})).resolves.toBeDefined();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

// ─── 2. Configurable Timeout ─────────────────────────────────────────────────

describe("Configurable timeout", () => {
    test("HttpClientService accepts custom timeoutMs", () => {
        expect(() => new HttpClientService(false, { timeoutMs: 10_000 })).not.toThrow();
        expect(() => new HttpClientService(false, { timeoutMs: 1_000 })).not.toThrow();
        expect(() => new HttpClientService(false, { timeoutMs: 300_000 })).not.toThrow();
    });

    test("HttpClientService rejects timeoutMs < 1000", () => {
        expect(() => new HttpClientService(false, { timeoutMs: 999 })).toThrow(SatimInvalidArgumentError);
        expect(() => new HttpClientService(false, { timeoutMs: 0 })).toThrow(SatimInvalidArgumentError);
    });

    test("HttpClientService rejects timeoutMs > 300000", () => {
        expect(() => new HttpClientService(false, { timeoutMs: 300_001 })).toThrow(SatimInvalidArgumentError);
    });

    test("HttpClientService rejects non-satim-module timeoutMs", () => {
        expect(() => new HttpClientService(false, { timeoutMs: "30000" as any })).toThrow(SatimInvalidArgumentError);
        expect(() => new HttpClientService(false, { timeoutMs: NaN })).toThrow(SatimInvalidArgumentError);
        expect(() => new HttpClientService(false, { timeoutMs: Infinity })).toThrow(SatimInvalidArgumentError);
    });

    test("Satim accepts timeoutMs via options", () => {
        expect(() => new Satim(
            { username: "u", password: "p", terminalId: "t" },
            { timeoutMs: 15_000 },
        )).not.toThrow();
    });

    test("Satim preserves timeoutMs after setTestMode()", () => {
        const satim = new Satim(
            { username: "u", password: "p", terminalId: "t" },
            { timeoutMs: 15_000 },
        );
        // setTestMode recreates the HttpClientService — should not throw
        expect(() => satim.setTestMode(true)).not.toThrow();
    });
});

// ─── 3. Multi-instance deduplication warning ─────────────────────────────────

describe("WebhookHandler — multi-instance warning", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    const makeSatim = () => new Satim({ username: "u", password: "p", terminalId: "t" });

    test("emits console.warn when no persistence hooks are provided", () => {
        new WebhookHandler(makeSatim(), {
            onResolveAmount: async () => 100,
        });
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0][0]).toContain("in-memory");
    });

    test("does not warn when onCheckDuplicate is provided", () => {
        new WebhookHandler(makeSatim(), {
            onResolveAmount: async () => 100,
            onCheckDuplicate: async () => false,
        });
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test("does not warn when onMarkProcessed is provided", () => {
        new WebhookHandler(makeSatim(), {
            onResolveAmount: async () => 100,
            onMarkProcessed: async () => {},
        });
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test("does not warn when suppressMultiInstanceWarning is true", () => {
        new WebhookHandler(makeSatim(), {
            onResolveAmount: async () => 100,
            suppressMultiInstanceWarning: true,
        });
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test("does not warn when both persistence hooks are provided", () => {
        const processed = new Set<string>();
        new WebhookHandler(makeSatim(), {
            onResolveAmount: async () => 100,
            onCheckDuplicate: (id) => processed.has(id),
            onMarkProcessed: (id) => { processed.add(id); },
        });
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

// ─── 4. Runtime typeof guards ────────────────────────────────────────────────

describe("Runtime typeof guards — amount()", () => {
    const satim = new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects array input (the classic JS coercion trap)", () => {
        expect(() => satim.amount([100] as any)).toThrow(SatimInvalidArgumentError);
        expect(() => satim.amount([] as any)).toThrow(SatimInvalidArgumentError);
    });

    test("rejects object input", () => {
        expect(() => satim.amount({} as any)).toThrow(SatimInvalidArgumentError);
        expect(() => satim.amount({ valueOf: () => 100 } as any)).toThrow(SatimInvalidArgumentError);
    });

    test("rejects null and undefined", () => {
        expect(() => satim.amount(null as any)).toThrow(SatimInvalidArgumentError);
        expect(() => satim.amount(undefined as any)).toThrow(SatimInvalidArgumentError);
    });

    test("rejects boolean", () => {
        expect(() => satim.amount(true as any)).toThrow(SatimInvalidArgumentError);
        expect(() => satim.amount(false as any)).toThrow(SatimInvalidArgumentError);
    });

    test("rejects string", () => {
        expect(() => satim.amount("100" as any)).toThrow(SatimInvalidArgumentError);
    });

    test("accepts valid numbers", () => {
        expect(() => satim.amount(100)).not.toThrow();
        expect(() => satim.amount(9999)).not.toThrow();
    });
});

describe("Runtime typeof guards — confirm() expectedAmount", () => {
    const satim = new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects array, object, null, string, boolean", async () => {
        await expect(satim.confirm("order-123", [100] as any)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.confirm("order-123", {} as any)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.confirm("order-123", null as any)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.confirm("order-123", "100" as any)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.confirm("order-123", true as any)).rejects.toThrow(SatimInvalidArgumentError);
    });
});

describe("Runtime typeof guards — refund() amount", () => {
    const satim = new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects array, object, null, string, boolean", async () => {
        await expect(satim.refund("order-123", [100] as any)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.refund("order-123", null as any)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.refund("order-123", "100" as any)).rejects.toThrow(SatimInvalidArgumentError);
    });
});

describe("Runtime typeof guards — orderId", () => {
    const satim = new Satim({ username: "u", password: "p", terminalId: "t" });

    test("confirm() rejects non-string orderId", async () => {
        await expect(satim.confirm(123 as any, 100)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.confirm(null as any, 100)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.confirm(["order-1"] as any, 100)).rejects.toThrow(SatimInvalidArgumentError);
    });

    test("refund() rejects non-string orderId", async () => {
        await expect(satim.refund(123 as any, 100)).rejects.toThrow(SatimInvalidArgumentError);
    });

    test("status() rejects non-string orderId", async () => {
        await expect(satim.status(123 as any)).rejects.toThrow(SatimInvalidArgumentError);
    });

    test("reverseOrder() rejects non-string orderId", async () => {
        await expect(satim.reverseOrder(123 as any)).rejects.toThrow(SatimInvalidArgumentError);
    });
});

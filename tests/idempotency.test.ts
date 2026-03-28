import { expect, test, describe, vi } from "vitest";
import { Satim, SatimInvalidArgumentError, SatimDuplicateOrderError, SatimGatewayError } from "../src";
import { deriveIdempotencyKey, deriveOrderNumber } from "../src/utils";

function makeSatim(mockRequest?: (...args: any[]) => Promise<any>) {
    const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
    if (mockRequest) {
        (satim as any).httpClientService = { handleApiRequest: mockRequest };
    }
    return satim;
}

function successRegister() {
    return { errorCode: "0", orderId: "satim-order-xyz", formUrl: "https://test.satim.dz/payment/form" };
}

// ─── deriveIdempotencyKey ───────────────────────────────────────────

describe("deriveIdempotencyKey", () => {
    test("produces deterministic output", () => {
        const a = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 1500 });
        const b = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 1500 });
        expect(a).toBe(b);
    });

    test("prefixed with dk_", () => {
        const key = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 1500 });
        expect(key.startsWith("dk_")).toBe(true);
    });

    test("different merchantRef produces different key", () => {
        const a = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 1500 });
        const b = deriveIdempotencyKey({ merchantRef: "cart-2", amount: 1500 });
        expect(a).not.toBe(b);
    });

    test("different amount produces different key", () => {
        const a = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 1500 });
        const b = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 2000 });
        expect(a).not.toBe(b);
    });

    test("different currency produces different key", () => {
        const a = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 1500, currency: "012" });
        const b = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 1500, currency: "840" });
        expect(a).not.toBe(b);
    });

    test("defaults to DZD (012) currency", () => {
        const a = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 1500 });
        const b = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 1500, currency: "012" });
        expect(a).toBe(b);
    });

    test("rejects empty merchantRef", () => {
        expect(() => deriveIdempotencyKey({ merchantRef: "", amount: 1500 })).toThrow();
        expect(() => deriveIdempotencyKey({ merchantRef: "  ", amount: 1500 })).toThrow();
    });

    test("rejects invalid amount", () => {
        expect(() => deriveIdempotencyKey({ merchantRef: "cart-1", amount: 0 })).toThrow();
        expect(() => deriveIdempotencyKey({ merchantRef: "cart-1", amount: -100 })).toThrow();
    });

    test("key is valid format for idempotencyKey()", () => {
        const key = deriveIdempotencyKey({ merchantRef: "cart-1", amount: 1500 });
        // dk_ + 64 hex chars = 67 chars total, all valid characters
        expect(key.length).toBe(67);
        expect(/^[a-zA-Z0-9_\-]{1,128}$/.test(key)).toBe(true);
    });
});

// ─── deriveOrderNumber ──────────────────────────────────────────────

describe("deriveOrderNumber", () => {
    test("produces deterministic 10-char satim-module string", () => {
        const a = deriveOrderNumber("cart-1");
        const b = deriveOrderNumber("cart-1");
        expect(a).toBe(b);
        expect(typeof a).toBe("string");
        expect(a).toMatch(/^\d{10}$/);
        expect(Number(a)).toBeGreaterThanOrEqual(1_000_000_000);
        expect(Number(a)).toBeLessThanOrEqual(9_999_999_999);
    });

    test("different merchantRef produces different number", () => {
        const a = deriveOrderNumber("cart-1");
        const b = deriveOrderNumber("cart-2");
        expect(a).not.toBe(b);
    });

    test("different mode produces different number (domain separation)", () => {
        const a = deriveOrderNumber("cart-1", "012", "register");
        const b = deriveOrderNumber("cart-1", "012", "preauth");
        expect(a).not.toBe(b);
    });
});

// ─── domain separation: register vs preauth ─────────────────────────

describe("domain separation: register vs preauth", () => {
    test("same merchantRef produces different keys for register vs preauth", () => {
        const regKey = deriveIdempotencyKey({ merchantRef: "inv-1", amount: 5000, mode: "register" });
        const preKey = deriveIdempotencyKey({ merchantRef: "inv-1", amount: 5000, mode: "preauth" });
        expect(regKey).not.toBe(preKey);
    });

    test("default mode is register", () => {
        const a = deriveIdempotencyKey({ merchantRef: "inv-1", amount: 5000 });
        const b = deriveIdempotencyKey({ merchantRef: "inv-1", amount: 5000, mode: "register" });
        expect(a).toBe(b);
    });
});

// ─── idempotencyKey() fluent setter ─────────────────────────────────

describe("idempotencyKey() fluent setter", () => {
    test("sets key and returns new instance", () => {
        const satim = makeSatim();
        const withKey = satim.idempotencyKey("my-key-123");
        expect(withKey).not.toBe(satim);
        expect((withKey as any)._idempotencyKey).toBe("my-key-123");
        expect((satim as any)._idempotencyKey).toBeUndefined();
    });

    test("rejects empty key", () => {
        expect(() => makeSatim().idempotencyKey("")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects key with invalid characters", () => {
        expect(() => makeSatim().idempotencyKey("key with spaces")).toThrow(SatimInvalidArgumentError);
        expect(() => makeSatim().idempotencyKey("key<script>")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects key longer than 128 chars", () => {
        expect(() => makeSatim().idempotencyKey("a".repeat(129))).toThrow(SatimInvalidArgumentError);
    });

    test("accepts valid key formats", () => {
        expect(() => makeSatim().idempotencyKey("dk_abc123")).not.toThrow();
        expect(() => makeSatim().idempotencyKey("order-42_v2")).not.toThrow();
        expect(() => makeSatim().idempotencyKey("a".repeat(128))).not.toThrow();
    });
});

// ─── register() with idempotency key ────────────────────────────────

describe("register() with idempotency key", () => {
    test("includes externalRequestId in payload when key is set", async () => {
        const mockRequest = vi.fn(async () => successRegister());
        const satim = makeSatim(mockRequest);

        await satim
            .amount(500)
            .returnUrl("https://example.com/success")
            .idempotencyKey("test-key-1")
            .register();

        const [, sentData] = mockRequest.mock.calls[0];
        expect(sentData.externalRequestId).toBe("test-key-1");
    });

    test("does NOT include externalRequestId when key is not set", async () => {
        const mockRequest = vi.fn(async () => successRegister());
        const satim = makeSatim(mockRequest);

        await satim
            .amount(500)
            .returnUrl("https://example.com/success")
            .register();

        const [, sentData] = mockRequest.mock.calls[0];
        expect(sentData.externalRequestId).toBeUndefined();
    });

    test("enables retries when idempotency key is set", async () => {
        const mockRequest = vi.fn(async () => successRegister());
        const satim = makeSatim(mockRequest);

        await satim
            .amount(500)
            .returnUrl("https://example.com/success")
            .idempotencyKey("test-key-2")
            .register();

        const [, , options] = mockRequest.mock.calls[0];
        expect(options.retryable).toBe(true);
    });

    test("does NOT enable retries without idempotency key", async () => {
        const mockRequest = vi.fn(async () => successRegister());
        const satim = makeSatim(mockRequest);

        await satim
            .amount(500)
            .returnUrl("https://example.com/success")
            .register();

        const [, , options] = mockRequest.mock.calls[0];
        expect(options.retryable).toBe(false);
    });
});

// ─── safeRegister() ─────────────────────────────────────────────────

describe("safeRegister()", () => {
    test("sends deterministic key and orderNumber", async () => {
        const mockRequest = vi.fn(async () => successRegister());
        const satim = makeSatim(mockRequest);

        await satim
            .amount(5000)
            .returnUrl("https://example.com/success")
            .safeRegister("cart-789");

        const [, sentData, options] = mockRequest.mock.calls[0];
        const expectedKey = deriveIdempotencyKey({ merchantRef: "cart-789", amount: 5000 });
        const expectedOrderNum = deriveOrderNumber("cart-789");

        expect(sentData.externalRequestId).toBe(expectedKey);
        expect(sentData.orderNumber).toBe(expectedOrderNum);
        expect(options.retryable).toBe(true);
    });

    test("same merchantRef always produces same key and orderNumber", async () => {
        const calls: any[] = [];
        const mockRequest = vi.fn(async (_e: any, data: any) => {
            calls.push(data);
            return successRegister();
        });

        const base = makeSatim(mockRequest).amount(1500).returnUrl("https://example.com/cb");

        await base.safeRegister("invoice-42");
        await base.safeRegister("invoice-42");

        expect(calls[0].externalRequestId).toBe(calls[1].externalRequestId);
        expect(calls[0].orderNumber).toBe(calls[1].orderNumber);
    });

    test("different merchantRef produces different key", async () => {
        const calls: any[] = [];
        const mockRequest = vi.fn(async (_e: any, data: any) => {
            calls.push(data);
            return successRegister();
        });

        const base = makeSatim(mockRequest).amount(1500).returnUrl("https://example.com/cb");

        await base.safeRegister("order-A");
        await base.safeRegister("order-B");

        expect(calls[0].externalRequestId).not.toBe(calls[1].externalRequestId);
    });

    test("throws SatimDuplicateOrderError on ErrorCode 1", async () => {
        const mockRequest = vi.fn(async () => {
            throw new SatimGatewayError("1", "Order already registered");
        });
        const satim = makeSatim(mockRequest);

        await expect(
            satim.amount(1500).returnUrl("https://example.com/cb").safeRegister("cart-dup"),
        ).rejects.toThrow(SatimDuplicateOrderError);

        try {
            await satim.amount(1500).returnUrl("https://example.com/cb").safeRegister("cart-dup");
        } catch (err) {
            expect(err).toBeInstanceOf(SatimDuplicateOrderError);
            expect((err as SatimDuplicateOrderError).merchantRef).toBe("cart-dup");
        }
    });

    test("re-throws non-duplicate gateway errors", async () => {
        const mockRequest = vi.fn(async () => {
            throw new SatimGatewayError("7", "System error");
        });
        const satim = makeSatim(mockRequest);

        await expect(
            satim.amount(1500).returnUrl("https://example.com/cb").safeRegister("cart-x"),
        ).rejects.toThrow(SatimGatewayError);
    });

    test("rejects empty merchantRef", async () => {
        const satim = makeSatim(vi.fn());
        await expect(
            satim.amount(1500).returnUrl("https://example.com/cb").safeRegister(""),
        ).rejects.toThrow(SatimInvalidArgumentError);
        await expect(
            satim.amount(1500).returnUrl("https://example.com/cb").safeRegister("   "),
        ).rejects.toThrow(SatimInvalidArgumentError);
    });

    test("validates amount and returnUrl before calling gateway", async () => {
        const mockRequest = vi.fn(async () => successRegister());
        const satim = makeSatim(mockRequest);

        // Missing amount
        await expect(satim.returnUrl("https://example.com/cb").safeRegister("cart-1"))
            .rejects.toThrow();

        // Missing returnUrl
        await expect(satim.amount(1500).safeRegister("cart-1"))
            .rejects.toThrow();

        expect(mockRequest).not.toHaveBeenCalled();
    });
});

// ─── safeRegisterPreAuth() ──────────────────────────────────────────

describe("safeRegisterPreAuth()", () => {
    test("calls registerPreAuth.do with idempotency", async () => {
        const mockRequest = vi.fn(async () => successRegister());
        const satim = makeSatim(mockRequest);

        await satim
            .amount(50000)
            .returnUrl("https://example.com/rental")
            .safeRegisterPreAuth("rental-deposit-99");

        const [endpoint, sentData] = mockRequest.mock.calls[0];
        expect(endpoint).toBe("/registerPreAuth.do");
        expect(sentData.externalRequestId).toBeDefined();
        expect(sentData.externalRequestId.startsWith("dk_")).toBe(true);
    });

    test("throws SatimDuplicateOrderError on ErrorCode 1", async () => {
        const mockRequest = vi.fn(async () => {
            throw new SatimGatewayError("1", "Order already registered");
        });
        const satim = makeSatim(mockRequest);

        await expect(
            satim.amount(50000).returnUrl("https://example.com/r").safeRegisterPreAuth("hold-dup"),
        ).rejects.toThrow(SatimDuplicateOrderError);
    });
});

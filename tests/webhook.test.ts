import { expect, test, describe, vi, beforeEach } from "vitest";
import { Satim, SatimMissingDataError, SatimInvalidArgumentError } from "../src";
import { WebhookHandler } from "../src/webhook";

function makeSatim(mockRequest?: (...args: any[]) => Promise<any>) {
    const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
    if (mockRequest) {
        (satim as any).httpClientService = { handleApiRequest: mockRequest };
    }
    return satim;
}

function successResponse(amount: string = "150000") {
    return { OrderStatus: "2", Amount: amount, params: { respCode: "00" } };
}

function pendingResponse() {
    return { OrderStatus: "0" };
}

function failedResponse() {
    return { OrderStatus: "6", actionCode: "2003" };
}

describe("WebhookHandler - creation", () => {
    test("requires onResolveAmount", () => {
        const satim = makeSatim();
        expect(() => satim.createWebhookHandler({} as any)).toThrow(SatimMissingDataError);
    });

    test("creates handler with valid options", () => {
        const satim = makeSatim();
        const handler = satim.createWebhookHandler({
            onResolveAmount: () => 1500,
        });
        expect(handler).toBeInstanceOf(WebhookHandler);
    });

    test("rejects invalid maxCallbacksPerWindow", () => {
        const satim = makeSatim();
        expect(() => satim.createWebhookHandler({
            onResolveAmount: () => 1500,
            maxCallbacksPerWindow: 0,
        })).toThrow(SatimInvalidArgumentError);
        expect(() => satim.createWebhookHandler({
            onResolveAmount: () => 1500,
            maxCallbacksPerWindow: 1.5,
        })).toThrow(SatimInvalidArgumentError);
    });

    test("rejects invalid rateLimitWindowMs", () => {
        const satim = makeSatim();
        expect(() => satim.createWebhookHandler({
            onResolveAmount: () => 1500,
            rateLimitWindowMs: 500,
        })).toThrow(SatimInvalidArgumentError);
    });
});

describe("WebhookHandler - orderId extraction", () => {
    const mockRequest = vi.fn(async () => successResponse());
    let handler: WebhookHandler;

    beforeEach(() => {
        mockRequest.mockClear();
        handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => 1500,
        });
    });

    test("extracts orderId from plain string", async () => {
        const result = await handler.verify("abc-123");
        expect(result).not.toBeNull();
        expect(result!.orderId).toBe("abc-123");
    });

    test("extracts orderId from URL string", async () => {
        const result = await handler.verify("https://my-app.com/success?orderId=order-42");
        expect(result).not.toBeNull();
        expect(result!.orderId).toBe("order-42");
    });

    test("extracts orderId from object with orderId property", async () => {
        const result = await handler.verify({ orderId: "obj-order-1" });
        expect(result).not.toBeNull();
        expect(result!.orderId).toBe("obj-order-1");
    });

    test("extracts orderId from object with satim-module orderId", async () => {
        const result = await handler.verify({ orderId: 12345 });
        expect(result).not.toBeNull();
        expect(result!.orderId).toBe("12345");
    });

    test("returns null for missing orderId", async () => {
        expect(await handler.verify(null)).toBeNull();
        expect(await handler.verify(undefined)).toBeNull();
        expect(await handler.verify("")).toBeNull();
        expect(await handler.verify({})).toBeNull();
        expect(await handler.verify({ orderId: "" })).toBeNull();
    });

    test("returns null for invalid orderId format", async () => {
        expect(await handler.verify("order<script>")).toBeNull();
        expect(await handler.verify("order with spaces")).toBeNull();
        expect(await handler.verify("a".repeat(129))).toBeNull();
    });

    test("trims whitespace from orderId", async () => {
        const result = await handler.verify("  abc-123  ");
        expect(result).not.toBeNull();
        expect(result!.orderId).toBe("abc-123");
    });
});

describe("WebhookHandler - server-side verification", () => {
    test("calls confirm() with resolved amount", async () => {
        const mockRequest = vi.fn(async () => successResponse("150000"));
        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => 1500,
        });

        const result = await handler.verify("order-1");

        expect(result).not.toBeNull();
        expect(result!.response.isSuccessful()).toBe(true);
        expect(result!.duplicate).toBe(false);
        expect(mockRequest).toHaveBeenCalledWith(
            "/public/acknowledgeTransaction.do",
            expect.objectContaining({ mdOrder: "order-1" }),
            expect.anything(),
        );
    });

    test("returns null when onResolveAmount returns undefined", async () => {
        const mockRequest = vi.fn(async () => successResponse());
        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => undefined,
        });

        const result = await handler.verify("unknown-order");
        expect(result).toBeNull();
        expect(mockRequest).not.toHaveBeenCalled();
    });

    test("returns null when onResolveAmount returns null", async () => {
        const mockRequest = vi.fn(async () => successResponse());
        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => null,
        });

        const result = await handler.verify("unknown-order");
        expect(result).toBeNull();
    });

    test("works with async onResolveAmount", async () => {
        const mockRequest = vi.fn(async () => successResponse("50000"));
        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: async () => 500,
        });

        const result = await handler.verify("order-async");
        expect(result).not.toBeNull();
        expect(result!.response.isSuccessful()).toBe(true);
    });

    test("propagates failed payment status without throwing", async () => {
        const mockRequest = vi.fn(async () => failedResponse());
        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => 1500,
        });

        const result = await handler.verify("order-failed");
        expect(result).not.toBeNull();
        expect(result!.response.isSuccessful()).toBe(false);
        expect(result!.response.isRejected()).toBe(true);
    });
});

describe("WebhookHandler - duplicate rejection", () => {
    test("in-memory: flags second callback as duplicate", async () => {
        const mockRequest = vi.fn(async () => successResponse());
        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => 1500,
        });

        const first = await handler.verify("order-dup");
        expect(first!.duplicate).toBe(false);

        const second = await handler.verify("order-dup");
        expect(second!.duplicate).toBe(true);
    });

    test("does not mark pending payments as processed", async () => {
        const mockRequest = vi.fn(async () => pendingResponse());
        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => 1500,
        });

        const first = await handler.verify("order-pending");
        expect(first!.duplicate).toBe(false);
        expect(first!.response.isPending()).toBe(true);

        // Should NOT be flagged as duplicate since it was pending
        const second = await handler.verify("order-pending");
        expect(second!.duplicate).toBe(false);
    });

    test("pluggable: uses custom onCheckDuplicate and onMarkProcessed", async () => {
        const processed = new Set<string>();
        const mockRequest = vi.fn(async () => successResponse());
        const checkDuplicate = vi.fn((id: string) => processed.has(id));
        const markProcessed = vi.fn((id: string) => { processed.add(id); });

        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => 1500,
            onCheckDuplicate: checkDuplicate,
            onMarkProcessed: markProcessed,
        });

        await handler.verify("order-plug");
        expect(checkDuplicate).toHaveBeenCalledWith("order-plug");
        expect(markProcessed).toHaveBeenCalledWith("order-plug");

        await handler.verify("order-plug");
        expect(checkDuplicate).toHaveBeenCalledTimes(2);
    });

    test("pluggable: async duplicate check", async () => {
        const processed = new Set<string>();
        const mockRequest = vi.fn(async () => successResponse());

        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => 1500,
            onCheckDuplicate: async (id) => processed.has(id),
            onMarkProcessed: async (id) => { processed.add(id); },
        });

        const first = await handler.verify("order-async-dup");
        expect(first!.duplicate).toBe(false);

        const second = await handler.verify("order-async-dup");
        expect(second!.duplicate).toBe(true);
    });
});

describe("WebhookHandler - rate limiting", () => {
    test("rejects callbacks after limit is reached", async () => {
        const mockRequest = vi.fn(async () => successResponse());
        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => 1500,
            maxCallbacksPerWindow: 3,
            rateLimitWindowMs: 60000,
        });

        // First 3 should pass (each with unique orderId to avoid duplicate logic)
        expect(await handler.verify("rl-1")).not.toBeNull();
        expect(await handler.verify("rl-2")).not.toBeNull();
        expect(await handler.verify("rl-3")).not.toBeNull();

        // 4th should be rate limited
        expect(await handler.verify("rl-4")).toBeNull();
    });
});

describe("WebhookHandler - amount verification integration", () => {
    test("throws on amount mismatch for successful payment", async () => {
        const mockRequest = vi.fn(async () => successResponse("99999"));
        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => 1500,  // expects 150000 minor units
        });

        await expect(handler.verify("order-mismatch")).rejects.toThrow("mismatch");
    });

    test("does not throw on amount for failed payment", async () => {
        const mockRequest = vi.fn(async () => failedResponse());
        const handler = makeSatim(mockRequest).createWebhookHandler({
            onResolveAmount: () => 1500,
        });

        const result = await handler.verify("order-fail-no-throw");
        expect(result).not.toBeNull();
        expect(result!.response.isRejected()).toBe(true);
    });
});

describe("WebhookHandler - full integration scenario", () => {
    test("end-to-end: register → callback → verify → duplicate", async () => {
        const db = new Map<string, number>();
        const processed = new Set<string>();

        // Simulate register
        const mockRegister = vi.fn(async () => ({
            errorCode: "0",
            orderId: "satim-order-xyz",
            formUrl: "https://test.satim.dz/payment/form",
        }));
        const satim = makeSatim(mockRegister);

        // Register a 2000 DZD payment
        const regResponse = await satim
            .amount(2000)
            .returnUrl("https://my-app.com/success")
            .dynamicCallbackUrl("https://api.my-app.com/webhooks/satim")
            .register();

        db.set(regResponse.getOrderId(), 2000);

        // Now simulate the webhook callback
        const mockConfirm = vi.fn(async () => ({
            OrderStatus: "2",
            Amount: "200000",
            params: { respCode: "00", respCode_desc: "Approved" },
        }));
        const satimForWebhook = makeSatim(mockConfirm);

        const webhook = satimForWebhook.createWebhookHandler({
            onResolveAmount: (orderId) => db.get(orderId),
            onCheckDuplicate: (orderId) => processed.has(orderId),
            onMarkProcessed: (orderId) => { processed.add(orderId); },
        });

        // First callback (from dynamicCallbackUrl POST)
        const result1 = await webhook.verify({ orderId: "satim-order-xyz" });
        expect(result1).not.toBeNull();
        expect(result1!.response.isSuccessful()).toBe(true);
        expect(result1!.response.getAmount()).toBe(2000);
        expect(result1!.duplicate).toBe(false);

        // Second callback (customer redirect to returnUrl)
        const result2 = await webhook.verify("https://my-app.com/success?orderId=satim-order-xyz");
        expect(result2).not.toBeNull();
        expect(result2!.duplicate).toBe(true);
        expect(result2!.response.isSuccessful()).toBe(true);
    });
});

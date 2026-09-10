/**
 * Regression tests for defects found in the end-to-end source review.
 *
 * Each block names the failure it locks out. These are the cases the
 * existing suites did not reach: circuit-breaker accounting on non-HTTP
 * failures, and webhook state transitions beyond pending/success.
 */
import { expect, test, describe, vi } from "vitest";
import { Satim } from "../src/Satim";
import { HttpClientService } from "../src/client";
import { CircuitBreaker } from "../src/circuit-breaker";
import { SatimError, SatimUnexpectedResponseError } from "../src/exceptions";

const CREDS = { username: "u", password: "p", terminalId: "t" };

/** Build a client whose fetch is fully scripted. */
function clientWith(fetchImpl: any, opts: any = {}) {
    return new HttpClientService(true, {
        fetch: fetchImpl,
        maxRetries: 0,
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 10_000 },
        ...opts,
    });
}

const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

// ─── Circuit breaker accounting ──────────────────────────────────────

describe("circuit breaker counts every transport failure mode", () => {
    test("opens on connection-level failures (fetch rejects with TypeError)", async () => {
        // Previously these reached a catch-all that reported nothing to the
        // breaker, so DNS/ECONNREFUSED/TLS outages never tripped it at all.
        const client = clientWith(async () => { throw new TypeError("fetch failed"); });
        for (let i = 0; i < 2; i++) {
            await expect(client.handleApiRequest("/getOrderStatus.do", { orderId: `n${i}` })).rejects.toThrow();
        }
        await expect(client.handleApiRequest("/getOrderStatus.do", { orderId: "n3" }))
            .rejects.toThrow(/Circuit breaker is open/);
    });

    test("opens on malformed payloads served with HTTP 200", async () => {
        // A gateway behind a proxy returning an HTML error page is degraded,
        // even though the status line says 200.
        const client = clientWith(async () => new Response("<html>502 Bad Gateway</html>", { status: 200 }));
        for (let i = 0; i < 2; i++) {
            await expect(client.handleApiRequest("/getOrderStatus.do", { orderId: `p${i}` })).rejects.toThrow();
        }
        await expect(client.handleApiRequest("/getOrderStatus.do", { orderId: "p3" }))
            .rejects.toThrow(/Circuit breaker is open/);
    });

    test("does not open on 4xx — a client-side fault, not gateway degradation", async () => {
        const client = clientWith(async () => new Response("nope", { status: 400, statusText: "Bad Request" }));
        for (let i = 0; i < 5; i++) {
            await expect(client.handleApiRequest("/getOrderStatus.do", { orderId: `c${i}` }))
                .rejects.toThrow(/HTTP Error: 400/);
        }
    });

    test("a HALF_OPEN probe that reports nothing cannot strand the breaker", () => {
        // Belt-and-braces: even if a caller loses track of a probe, the
        // breaker must not reject every request for the life of the process.
        vi.useFakeTimers();
        try {
            const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
            breaker.onFailure();
            expect(breaker.getState()).toBe("OPEN");

            vi.advanceTimersByTime(1001);
            expect(breaker.allowRequest()).toBe(true);   // probe admitted
            expect(breaker.allowRequest()).toBe(false);  // second probe held back

            vi.advanceTimersByTime(1001);                // probe never reported
            expect(breaker.allowRequest()).toBe(true);   // abandoned, fresh probe admitted
        } finally {
            vi.useRealTimers();
        }
    });

    test("a failed probe still reopens the breaker rather than admitting a herd", async () => {
        const client = clientWith(async () => { throw new TypeError("fetch failed"); },
            { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 30 } });
        await expect(client.handleApiRequest("/getOrderStatus.do", { orderId: "a" })).rejects.toThrow();
        await new Promise(r => setTimeout(r, 40));
        // Probe is admitted and fails, so the breaker must be closed again to traffic.
        await expect(client.handleApiRequest("/getOrderStatus.do", { orderId: "b" })).rejects.toThrow(/Network/);
        await expect(client.handleApiRequest("/getOrderStatus.do", { orderId: "c" }))
            .rejects.toThrow(/Circuit breaker is open/);
    });

    test("the TLS guard neither counts as a failure nor consumes a probe", async () => {
        const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        try {
            const client = clientWith(async () => jsonResponse({ OrderStatus: "2" }),
                { circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 10_000 } });
            for (let i = 0; i < 5; i++) {
                await expect(client.handleApiRequest("/getOrderStatus.do", { orderId: `t${i}` }))
                    .rejects.toThrow(SatimError);
            }
            // Fixing the environment must not leave a circuit open behind it.
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
            await expect(client.handleApiRequest("/getOrderStatus.do", { orderId: "ok" })).resolves.toBeTruthy();
        } finally {
            if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
        }
    });
});

describe("timeout classification is independent of the fetch implementation", () => {
    test("a custom fetch rejecting with a plain AbortError is treated as a timeout", async () => {
        // The documented production path (undici Pool, wrappers) does not
        // necessarily reject with a DOMException.
        let calls = 0;
        const client = clientWith(async () => {
            calls++;
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            throw err;
        }, { maxRetries: 2 });

        const error = await client.handleApiRequest("/getOrderStatus.do", { orderId: "x" })
            .then(() => null, (e: SatimUnexpectedResponseError) => e);

        expect(error).toBeInstanceOf(SatimUnexpectedResponseError);
        expect(error!.isTimeout).toBe(true);
        expect(error!.errorCategory).toBe("timeout");
        expect(calls).toBe(3); // retried, not misclassified as a dead end
    });
});

// ─── Webhook state handling ──────────────────────────────────────────

/**
 * Build a Satim whose transport is fully scripted.
 *
 * The stub is assigned after construction: the constructor only accepts a
 * real `HttpClientService` instance, and anything else is read as options
 * for a live transport.
 */
function stubbedSatim(handleApiRequest: (endpoint: string, data: any, opts?: any) => Promise<any>) {
    const satim = new Satim(CREDS);
    (satim as any).httpClientService = { handleApiRequest };
    return satim;
}

/** Drive a handler through a scripted sequence of gateway responses. */
function webhookFixture(responses: any[]) {
    const queue = [...responses];
    const marked: string[] = [];
    const processed = new Set<string>();
    const satim = stubbedSatim(() => Promise.resolve(queue.shift()));
    const handler = satim.createWebhookHandler({
        onResolveAmount: () => 100,
        onCheckDuplicate: (id) => processed.has(id),
        onMarkProcessed: (id) => { processed.add(id); marked.push(id); },
    });
    return { handler, marked };
}

describe("webhook marks only definitively terminal orders", () => {
    test("a pre-authorized hold is not marked, so the capture callback still fulfils", async () => {
        const { handler, marked } = webhookFixture([
            { OrderStatus: "1", Amount: 10000 },  // funds held
            { OrderStatus: "2", Amount: 10000 },  // captured
        ]);
        const hold = await handler.verify({ orderId: "ORDER1" });
        expect(hold!.response.isPreAuthorized()).toBe(true);
        expect(hold!.duplicate).toBe(false);
        expect(marked).toHaveLength(0);

        const capture = await handler.verify({ orderId: "ORDER1" });
        expect(capture!.response.isSuccessful()).toBe(true);
        expect(capture!.duplicate).toBe(false); // must be fulfillable
        expect(marked).toEqual(["ORDER1"]);
    });

    test("a declined attempt is not marked, so a successful retry still fulfils", async () => {
        const { handler, marked } = webhookFixture([
            { actionCode: "2003", ErrorMessage: "payment is declined" },
            { OrderStatus: "2", Amount: 10000 },
        ]);
        const declined = await handler.verify({ orderId: "ORDER2" });
        expect(declined!.response.isRejected()).toBe(true);
        expect(marked).toHaveLength(0);

        const retry = await handler.verify({ orderId: "ORDER2" });
        expect(retry!.response.isSuccessful()).toBe(true);
        expect(retry!.duplicate).toBe(false); // customer paid — must be fulfillable
    });

    test("pending stays unmarked", async () => {
        const { handler, marked } = webhookFixture([{ OrderStatus: "0" }]);
        await handler.verify({ orderId: "ORDER3" });
        expect(marked).toHaveLength(0);
    });

    test("terminal states are marked and replay as duplicates", async () => {
        for (const status of ["2", "3", "4"]) {
            const { handler, marked } = webhookFixture([
                { OrderStatus: status, Amount: 10000 },
                { OrderStatus: status, Amount: 10000 },
            ]);
            const first = await handler.verify({ orderId: "ORDER4" });
            expect(first!.duplicate).toBe(false);
            expect(marked).toEqual(["ORDER4"]);

            const replay = await handler.verify({ orderId: "ORDER4" });
            expect(replay!.duplicate).toBe(true);
            expect(marked).toEqual(["ORDER4"]); // marked exactly once
        }
    });

    test("a replay re-reads state instead of re-acknowledging the transaction", async () => {
        const endpoints: string[] = [];
        const satim = stubbedSatim((endpoint: string) => {
            endpoints.push(endpoint);
            return Promise.resolve({ OrderStatus: "2", Amount: 10000 });
        });
        const processed = new Set<string>();
        const handler = satim.createWebhookHandler({
            onResolveAmount: () => 100,
            onCheckDuplicate: (id) => processed.has(id),
            onMarkProcessed: (id) => { processed.add(id); },
        });

        await handler.verify({ orderId: "ORDER5" });
        await handler.verify({ orderId: "ORDER5" });

        expect(endpoints[0]).toBe("/public/acknowledgeTransaction.do");
        expect(endpoints[1]).toBe("/getOrderStatus.do");
    });

    test("the replay path still verifies the amount", async () => {
        const satim = stubbedSatim(() => Promise.resolve({ OrderStatus: "2", Amount: 999999 }));
        const handler = satim.createWebhookHandler({
            onResolveAmount: () => 100,
            onCheckDuplicate: () => true, // already processed → status() path
            onMarkProcessed: () => {},
        });
        await expect(handler.verify({ orderId: "ORDER6" })).rejects.toThrow(/mismatch/);
    });
});

describe("webhook rejections are distinguishable", () => {
    function handlerWithLimit(max: number) {
        const satim = stubbedSatim(() => Promise.resolve({ OrderStatus: "2", Amount: 10000 }));
        return satim.createWebhookHandler({
            onResolveAmount: (id) => (id === "KNOWN" ? 100 : undefined),
            onCheckDuplicate: () => false,
            onMarkProcessed: () => {},
            maxCallbacksPerWindow: max,
            rateLimitWindowMs: 60_000,
        });
    }

    test("inspect() separates junk, rate limiting, and unknown orders", async () => {
        const handler = handlerWithLimit(2);

        expect(await handler.inspect({ nope: true })).toEqual({ verified: false, reason: "invalid_source" });

        const ok = await handler.inspect({ orderId: "KNOWN" });
        expect(ok.verified).toBe(true);

        expect(await handler.inspect({ orderId: "OTHER" }))
            .toEqual({ verified: false, reason: "unknown_order" });

        // Window is now full — a real callback must be reported as
        // retryable, not silently dropped.
        expect(await handler.inspect({ orderId: "KNOWN" }))
            .toEqual({ verified: false, reason: "rate_limited" });
    });

    test("malformed sources do not consume rate-limit budget", async () => {
        const handler = handlerWithLimit(1);
        for (let i = 0; i < 10; i++) await handler.inspect("!!! not an order id !!!");
        expect((await handler.inspect({ orderId: "KNOWN" })).verified).toBe(true);
    });

    test("verify() still collapses every rejection to null", async () => {
        const handler = handlerWithLimit(5);
        expect(await handler.verify({ nope: true })).toBeNull();
        expect(await handler.verify({ orderId: "OTHER" })).toBeNull();
    });
});

// ─── Gateway wire format ─────────────────────────────────────────────

describe("gateway numeric fields are accepted on both schemas", () => {
    test("a registration carrying a numeric errorCode is not rejected", async () => {
        // The live gateway returns JSON numbers: a bad-credential probe against
        // test.satim.dz answers {"errorCode":5,"errorMessage":"Access denied"}.
        // Requiring a string here threw on every successful errorCode: 0
        // registration, which would have blocked the first real transaction.
        const satim = stubbedSatim(() =>
            Promise.resolve({ orderId: "ord-1", formUrl: "https://test.satim.dz/pay/x", errorCode: 0 }));
        const res = await satim.amount(5000).returnUrl("https://shop.dz/r").register();
        expect(res.getOrderId()).toBe("ord-1");
        expect(res.getRawResponse().errorCode).toBe("0");
    });

    test("string errorCode and absent errorCode still work", async () => {
        for (const extra of [{ errorCode: "0" }, {}]) {
            const satim = stubbedSatim(() =>
                Promise.resolve({ orderId: "ord-2", formUrl: "https://test.satim.dz/pay/y", ...extra }));
            const res = await satim.amount(5000).returnUrl("https://shop.dz/r").register();
            expect(res.getOrderId()).toBe("ord-2");
        }
    });

    test("a non-scalar errorCode is still rejected", async () => {
        const satim = stubbedSatim(() =>
            Promise.resolve({ orderId: "ord-3", formUrl: "https://test.satim.dz/pay/z", errorCode: { nested: true } }));
        await expect(satim.amount(5000).returnUrl("https://shop.dz/r").register())
            .rejects.toThrow(/must be a string or number/);
    });
});

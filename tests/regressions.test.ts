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
import {
    SatimError, SatimUnexpectedResponseError, SatimInvalidCredentialsError,
    SatimInvalidArgumentError,
} from "../src/exceptions";
import { ConfirmResponse } from "../src/responses/confirm";
import { extractOrderId } from "../src/webhook/extract";
import { verifyCallbackChecksum, buildSignedString } from "../src/webhook/checksum";

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

// ─── Configurable base URL ───────────────────────────────────────────

describe("baseUrl override", () => {
    test("replaces the host the endpoint is appended to", async () => {
        let seen = "";
        const client = new HttpClientService(false, {
            baseUrl: "http://localhost:8787/payment/rest",
            fetch: (async (url: any) => {
                seen = String(url);
                return new Response(JSON.stringify({ OrderStatus: 2 }), { status: 200 });
            }) as any,
        });
        await client.handleApiRequest("/getOrderStatus.do", { orderId: "x" });
        expect(seen).toBe("http://localhost:8787/payment/rest/getOrderStatus.do");
    });

    test("a trailing slash does not produce a double slash", async () => {
        let seen = "";
        const client = new HttpClientService(false, {
            baseUrl: "https://gw.satim.dz/payment/rest/",
            fetch: (async (url: any) => {
                seen = String(url);
                return new Response("{}", { status: 200 });
            }) as any,
        });
        await client.handleApiRequest("/refund.do", {});
        expect(seen).toBe("https://gw.satim.dz/payment/rest/refund.do");
    });

    test("overrides testMode rather than being overridden by it", async () => {
        let seen = "";
        const client = new HttpClientService(true, {
            baseUrl: "http://127.0.0.1:9999/payment/rest",
            fetch: (async (url: any) => {
                seen = String(url);
                return new Response("{}", { status: 200 });
            }) as any,
        });
        await client.handleApiRequest("/getOrderStatus.do", {});
        expect(seen).toContain("127.0.0.1:9999");
        expect(seen).not.toContain("satim.dz");
    });

    test("plaintext http is allowed only for local hosts", () => {
        for (const url of [
            "http://localhost:8787/payment/rest",
            "http://127.0.0.1:8787/payment/rest",
            "http://[::1]:8787/payment/rest",
            "http://192.168.1.10/payment/rest",
        ]) {
            expect(() => new HttpClientService(false, { baseUrl: url })).not.toThrow();
        }
        // Credentials travel in every request body, so plaintext to a public
        // host must be refused rather than trusted.
        for (const url of ["http://cib.satim.dz/payment/rest", "http://evil.example/payment/rest"]) {
            expect(() => new HttpClientService(false, { baseUrl: url })).toThrow(/HTTPS/);
        }
    });

    test("rejects malformed and non-http schemes", () => {
        for (const url of ["not a url", "ftp://gw.satim.dz/rest", "file:///etc/passwd", ""]) {
            expect(() => new HttpClientService(false, { baseUrl: url })).toThrow(/valid http\/https URL/);
        }
    });

    test("omitting it keeps the built-in hosts", async () => {
        const seen: string[] = [];
        const fetchImpl = (async (url: any) => {
            seen.push(String(url));
            return new Response("{}", { status: 200 });
        }) as any;
        await new HttpClientService(false, { fetch: fetchImpl }).handleApiRequest("/getOrderStatus.do", {});
        await new HttpClientService(true, { fetch: fetchImpl }).handleApiRequest("/getOrderStatus.do", {});
        expect(seen[0]).toContain("cib.satim.dz");
        expect(seen[1]).toContain("test2.satim.dz");
    });
});

// ─── Local development escape hatch ──────────────────────────────────

describe("allowPrivateUrls", () => {
    const satim = () => new Satim(CREDS);

    test("loopback callback URLs are rejected by default", () => {
        for (const url of ["http://localhost:3000/cb", "http://127.0.0.1:3000/cb", "http://[::1]:3000/cb"]) {
            expect(() => satim().returnUrl(url)).toThrow(/private\/reserved/);
            expect(() => satim().failUrl(url)).toThrow(/private\/reserved/);
            expect(() => satim().dynamicCallbackUrl(url)).toThrow(/private\/reserved/);
        }
    });

    test("the rejection tells the developer how to proceed", () => {
        expect(() => satim().returnUrl("http://localhost:3000/cb"))
            .toThrow(/allowPrivateUrls\(true\)/);
    });

    test("opting in allows them on all three URL setters", () => {
        const dev = satim().allowPrivateUrls(true);
        expect(() => dev.returnUrl("http://localhost:3000/return")).not.toThrow();
        expect(() => dev.failUrl("http://192.168.1.5:3000/fail")).not.toThrow();
        expect(() => dev.dynamicCallbackUrl("http://127.0.0.1:3000/cb")).not.toThrow();
    });

    test("the opt-in survives cloning through other setters", () => {
        expect(() => satim()
            .allowPrivateUrls(true)
            .amount(5000)
            .description("x")
            .returnUrl("http://localhost:3000/return")).not.toThrow();
    });

    test("it is per-instance and does not leak to other clients", () => {
        satim().allowPrivateUrls(true).returnUrl("http://localhost:3000/return");
        // A second client must still reject the very same URL: a lenient
        // check must never populate the shared validation cache.
        expect(() => satim().returnUrl("http://localhost:3000/return")).toThrow(/private\/reserved/);
    });

    test("turning it back off restores the guard", () => {
        const dev = satim().allowPrivateUrls(true);
        expect(() => dev.allowPrivateUrls(false).returnUrl("http://localhost:3000/cb")).toThrow();
    });

    test("public URLs are unaffected either way", () => {
        for (const client of [satim(), satim().allowPrivateUrls(true)]) {
            expect(() => client.returnUrl("https://shop.dz/return")).not.toThrow();
        }
    });

    test("obfuscated encodings normalise to loopback and stay blocked when strict", () => {
        // WHATWG URL rewrites all of these to 127.0.0.1 before validation,
        // so strict mode rejects them as loopback rather than as encodings.
        for (const url of ["http://2130706433/x", "http://0x7f000001/x", "http://0177.0.0.1/x"]) {
            expect(() => satim().returnUrl(url)).toThrow();
        }
    });
});

// ─── BPC order statuses 5-8 ──────────────────────────────────────────

describe("every documented BPC order status maps to exactly one predicate", () => {
    const PREDICATES = [
        "isSuccessful", "isPending", "isPreAuthorized", "isReversed", "isRefunded",
        "isPartiallyCaptured", "isExpired", "isCancelled", "isRejected", "isFailed",
    ] as const;

    const fires = (status: string) => {
        const r = new ConfirmResponse({ OrderStatus: status, Amount: 5000 } as any);
        return PREDICATES.filter((p) => (r as any)[p]());
    };

    test.each([
        ["0", "isPending"], ["1", "isPreAuthorized"], ["2", "isSuccessful"],
        ["3", "isReversed"], ["4", "isRefunded"], ["5", "isPending"],
        ["6", "isRejected"], ["7", "isPending"], ["8", "isPartiallyCaptured"],
    ])("status %s -> %s, and nothing else", (status, expected) => {
        expect(fires(status)).toEqual([expected]);
    });

    test("in-flight states are never reported as failed", () => {
        // 5 is 3-D Secure in progress, 7 is pending payment, 8 is a partial
        // capture. Reporting any of them as failed invites a merchant to
        // cancel or re-charge an order that is still moving.
        for (const status of ["5", "7", "8"]) {
            const r = new ConfirmResponse({ OrderStatus: status } as any);
            expect(r.isFailed()).toBe(false);
        }
    });

    test("a declined order is rejected rather than merely failed", () => {
        const r = new ConfirmResponse({ OrderStatus: "6" } as any);
        expect(r.isRejected()).toBe(true);
        expect(r.isFailed()).toBe(false);
    });

    test("an unrecognised status still falls back to the actionCode chain", () => {
        const r = new ConfirmResponse({ OrderStatus: "99", actionCode: "10" } as any);
        expect(r.isCancelled()).toBe(true);
    });
});

// ─── Credential failures are typed the same way everywhere ───────────

describe("bad credentials raise the same error whichever endpoint answers", () => {
    test("HTTP 401 with a bare string body maps to SatimInvalidCredentialsError", async () => {
        // acknowledgeTransaction.do answers 401 with `"Access denied"` while
        // register.do answers 200 with errorCode 5. Same failure, so the same
        // typed error — otherwise what a caller catches depends on the method.
        const client = new HttpClientService(false, {
            baseUrl: "https://gw.satim.dz/payment/rest",
            fetch: (async () => new Response('"Access denied"', { status: 401 })) as any,
        });
        await expect(client.handleApiRequest("/public/acknowledgeTransaction.do", {}))
            .rejects.toBeInstanceOf(SatimInvalidCredentialsError);
    });

    test("403 maps the same way, other 4xx do not", async () => {
        const make = (status: number) => new HttpClientService(false, {
            baseUrl: "https://gw.satim.dz/payment/rest",
            fetch: (async () => new Response("nope", { status })) as any,
        });
        await expect(make(403).handleApiRequest("/refund.do", {}))
            .rejects.toBeInstanceOf(SatimInvalidCredentialsError);
        await expect(make(404).handleApiRequest("/refund.do", {}))
            .rejects.toThrow(/HTTP Error: 404/);
    });

    test("a credential failure does not open the circuit breaker", async () => {
        const client = new HttpClientService(false, {
            baseUrl: "https://gw.satim.dz/payment/rest",
            circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 10_000 },
            fetch: (async () => new Response('"Access denied"', { status: 401 })) as any,
        });
        for (let i = 0; i < 4; i++) {
            await expect(client.handleApiRequest("/refund.do", {}))
                .rejects.toBeInstanceOf(SatimInvalidCredentialsError);
        }
    });
});

// ─── Endpoints the SDK was missing ───────────────────────────────────

describe("deposit / decline / statusExtended", () => {
    function recorder(response: any = { OrderStatus: "2", Amount: 500000 }) {
        const calls: any[] = [];
        const satim = new Satim(CREDS);
        (satim as any).httpClientService = {
            handleApiRequest: (endpoint: string, data: any, opts: any) => {
                calls.push({ endpoint, data, opts });
                return Promise.resolve(response);
            },
        };
        return { satim, calls };
    }

    test("deposit captures a pre-auth via /deposit.do and is not retried", async () => {
        const { satim, calls } = recorder();
        await satim.deposit("order-1", 5000);
        expect(calls[0].endpoint).toBe("/deposit.do");
        expect(calls[0].data.amount).toBe(500000);   // minor units
        expect(calls[0].opts).toEqual({ retryable: false });
    });

    test("deposit without an amount sends 0, which BPC reads as the full order", async () => {
        const { satim, calls } = recorder();
        await satim.deposit("order-1");
        expect(calls[0].data.amount).toBe(0);
    });

    test("deposit validates its inputs", async () => {
        const { satim } = recorder();
        await expect(satim.deposit("bad id!")).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.deposit("order-1", -5)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.deposit("order-1", 1.234)).rejects.toThrow(SatimInvalidArgumentError);
    });

    test("decline cancels an unpaid order and sends both identifiers", async () => {
        const { satim, calls } = recorder({ OrderStatus: "6" });
        await satim.decline("order-1", "CART1001");
        expect(calls[0].endpoint).toBe("/decline.do");
        expect(calls[0].data.orderId).toBe("order-1");
        expect(calls[0].data.orderNumber).toBe("CART1001");
        expect(calls[0].opts).toEqual({ retryable: false });
    });

    test("statusExtended reads the authoritative status and is retryable", async () => {
        const { satim, calls } = recorder();
        const r = await satim.statusExtended("order-1");
        expect(calls[0].endpoint).toBe("/getOrderStatusExtended.do");
        expect(calls[0].opts).toBeUndefined();   // defaults to retryable
        expect(r.isSuccessful()).toBe(true);
    });
});

// ─── Callback format and signature ───────────────────────────────────

describe("the gateway's real callback format", () => {
    const ID = "3ff6962a-7dcc-4283-ab50-a6d7dd3386fe";

    test("mdOrder is extracted — BPC callbacks carry no orderId at all", () => {
        // Documented notification URL:
        //   ...?mdOrder=...&orderNumber=...&operation=deposited&status=1
        // Reading only `orderId` made every real callback unextractable, so
        // the handler rejected genuine payment notifications as junk.
        expect(extractOrderId(
            `https://shop.dz/callback/?mdOrder=${ID}&orderNumber=10747&operation=deposited&status=1`,
        )).toBe(ID);
        expect(extractOrderId({ mdOrder: ID, operation: "deposited", status: "1" })).toBe(ID);
        expect(extractOrderId({ url: `/cb?mdOrder=${ID}&status=1` })).toBe(ID);
    });

    test("orderId still works and wins when both are present", () => {
        expect(extractOrderId(`https://shop.dz/cb?orderId=${ID}`)).toBe(ID);
        expect(extractOrderId({ orderId: ID, mdOrder: "other-value" })).toBe(ID);
    });

    test("the format guard still applies to mdOrder", () => {
        expect(extractOrderId({ mdOrder: "../../etc/passwd" })).toBeNull();
        expect(extractOrderId({ mdOrder: "a".repeat(129) })).toBeNull();
    });

    test("the signed string matches BPC's worked example", () => {
        const params = {
            amount: "123456", mdOrder: ID, operation: "deposited",
            orderNumber: "10747", status: "1",
            checksum: "IGNORED", sign_alias: "IGNORED",
        };
        expect(buildSignedString(params)).toBe(
            "amount;123456;mdOrder;3ff6962a-7dcc-4283-ab50-a6d7dd3386fe;"
            + "operation;deposited;orderNumber;10747;status;1;",
        );
    });

    test("checksum verification matches node:crypto's HMAC", async () => {
        const { createHmac } = await import("node:crypto");
        const params: Record<string, string> = {
            amount: "123456", mdOrder: ID, operation: "deposited", status: "1",
        };
        const secret = "shared-secret-from-the-bank";
        const checksum = createHmac("sha256", secret)
            .update(buildSignedString(params)).digest("hex").toUpperCase();

        expect(verifyCallbackChecksum({ ...params, checksum }, secret)).toBe(true);
        expect(verifyCallbackChecksum({ ...params, amount: "1", checksum }, secret)).toBe(false);
        expect(verifyCallbackChecksum({ ...params, checksum }, "wrong-secret")).toBe(false);
        expect(verifyCallbackChecksum(params, secret)).toBe(false);           // no checksum
        expect(verifyCallbackChecksum({ ...params, checksum }, "")).toBe(false); // no secret
    });

    test("keys longer than the HMAC block are pre-hashed correctly", async () => {
        const { createHmac } = await import("node:crypto");
        const secret = "k".repeat(200);
        const params = { a: "1", b: "2" };
        const checksum = createHmac("sha256", secret)
            .update(buildSignedString(params)).digest("hex").toUpperCase();
        expect(verifyCallbackChecksum({ ...params, checksum }, secret)).toBe(true);
    });

    test("a forged callback is rejected before the gateway is contacted", async () => {
        let gatewayCalls = 0;
        const satim = new Satim(CREDS);
        (satim as any).httpClientService = {
            handleApiRequest: () => { gatewayCalls++; return Promise.resolve({ OrderStatus: "2", Amount: 10000 }); },
        };
        const handler = satim.createWebhookHandler({
            onResolveAmount: () => 100,
            callbackSecret: "shared-secret",
            suppressMultiInstanceWarning: true,
        });

        const outcome = await handler.inspect(
            `https://shop.dz/cb?mdOrder=${ID}&amount=10000&checksum=DEADBEEF`,
        );
        expect(outcome).toEqual({ verified: false, reason: "bad_signature" });
        expect(gatewayCalls).toBe(0);
    });

    test("a correctly signed callback verifies end to end", async () => {
        const { createHmac } = await import("node:crypto");
        const satim = new Satim(CREDS);
        (satim as any).httpClientService = {
            handleApiRequest: () => Promise.resolve({ OrderStatus: "2", Amount: 10000 }),
        };
        const handler = satim.createWebhookHandler({
            onResolveAmount: () => 100,
            callbackSecret: "shared-secret",
            suppressMultiInstanceWarning: true,
        });

        const params: Record<string, string> = { mdOrder: ID, amount: "10000", status: "1" };
        const checksum = createHmac("sha256", "shared-secret")
            .update(buildSignedString(params)).digest("hex").toUpperCase();
        const query = new URLSearchParams({ ...params, checksum }).toString();

        const outcome = await handler.inspect(`https://shop.dz/cb?${query}`);
        expect(outcome.verified).toBe(true);
    });

    test("without a configured secret, signatures are not required", async () => {
        const satim = new Satim(CREDS);
        (satim as any).httpClientService = {
            handleApiRequest: () => Promise.resolve({ OrderStatus: "2", Amount: 10000 }),
        };
        const handler = satim.createWebhookHandler({
            onResolveAmount: () => 100,
            suppressMultiInstanceWarning: true,
        });
        const outcome = await handler.inspect(`https://shop.dz/cb?mdOrder=${ID}`);
        expect(outcome.verified).toBe(true);
    });
});

/**
 * End-to-end walkthrough of the SDK against the mock gateway.
 *
 * Runs the whole merchant lifecycle without credentials and without
 * touching the network: register, pay on the hosted form, receive the
 * server-to-server callback, confirm, refund, and the failure paths.
 *
 *     node mock/gateway.mjs        # terminal 1
 *     node mock/demo.mjs           # terminal 2
 *
 * Build the SDK first (`npm run build`) — this imports from `dist/`, the
 * same entry point a merchant consumes.
 */
import { createServer } from "node:http";
import { Satim, HttpClientService } from "../dist/index.js";

const GATEWAY_PORT = Number(process.env.PORT ?? 8787);
const MERCHANT_PORT = Number(process.env.MERCHANT_PORT ?? 8788);
const GATEWAY = `http://localhost:${GATEWAY_PORT}`;

// The SDK's SSRF guard rejects `localhost` and `127.0.0.1` in returnUrl /
// dynamicCallbackUrl, which is correct for production and awkward for local
// development. `localtest.me` and its subdomains resolve to loopback while
// reading as an ordinary public hostname, so the guard lets them through.
const MERCHANT = `http://shop.localtest.me:${MERCHANT_PORT}`;

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const step = (n, s) => console.log(`\n\x1b[1m${n}. ${s}\x1b[0m`);

// ── The merchant's own state and callback endpoint ───────────────────

/** orderId -> what we believe the order should cost. The source of truth. */
const ledger = new Map();
const fulfilled = new Set();
const processed = new Set();
let callbacksSeen = 0;

const satim = new Satim(
    { username: "test_merchant", password: "test_password", terminalId: "E005005099" },
    new HttpClientService(false, { baseUrl: `${GATEWAY}/payment/rest`, maxRetries: 2 }),
);

const webhook = satim.createWebhookHandler({
    onResolveAmount: (orderId) => ledger.get(orderId),
    onCheckDuplicate: (orderId) => processed.has(orderId),
    onMarkProcessed: (orderId) => { processed.add(orderId); },
});

const merchantServer = createServer(async (req, res) => {
    if (!req.url.startsWith("/callback")) { res.writeHead(404).end(); return; }
    callbacksSeen++;
    // `inspect()` names the rejection reason so the status code can be right.
    const outcome = await webhook.inspect(`${MERCHANT}${req.url}`).catch((err) => ({ error: err }));

    if (outcome.error) {
        console.log(`   callback -> ${bad("threw")}: ${outcome.error.message}`);
        res.writeHead(500).end();
        return;
    }
    if (!outcome.verified) {
        const status = { invalid_source: 400, unknown_order: 404, rate_limited: 429 }[outcome.reason];
        console.log(`   callback -> ${bad(outcome.reason)} (HTTP ${status})`);
        res.writeHead(status).end();
        return;
    }
    const { orderId, response, duplicate } = outcome.result;
    if (response.isSuccessful() && !duplicate) fulfilled.add(orderId);
    console.log(`   callback -> verified: successful=${response.isSuccessful()} duplicate=${duplicate}`
        + ` fulfilled=${fulfilled.has(orderId)}`);
    res.writeHead(200).end();
});

/** Drive the hosted payment page the way a customer's browser would. */
async function payWith(formUrl, pan) {
    const mdOrder = new URL(formUrl).searchParams.get("mdOrder");
    const res = await fetch(`${GATEWAY}/payment/rest/__pay`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ mdOrder, pan }),
        redirect: "manual",
    });
    return res.headers.get("location");
}

async function register(ref, amountDZD, { preAuth = false } = {}) {
    const configured = satim
        .amount(amountDZD)
        .returnUrl(`${MERCHANT}/return`)
        .failUrl(`${MERCHANT}/failed`)
        .dynamicCallbackUrl(`${MERCHANT}/callback`)
        .description(`Commande ${ref}`);
    const reg = preAuth ? await configured.safeRegisterPreAuth(ref) : await configured.safeRegister(ref);
    ledger.set(reg.getOrderId(), amountDZD);
    return reg;
}

// ── The walkthrough ──────────────────────────────────────────────────

async function main() {
    await new Promise((r) => merchantServer.listen(MERCHANT_PORT, r));
    await fetch(`${GATEWAY}/__reset`, { method: "POST" });
    console.log(dim(`gateway ${GATEWAY}   merchant ${MERCHANT}`));

    step(1, "Successful payment, end to end");
    {
        const reg = await register("CART-1001", 2500);
        console.log(`   registered ${reg.getOrderId()}`);
        console.log(dim(`   form: ${reg.getUrl()}`));
        const back = await payWith(reg.getUrl(), "6280581000000000");
        console.log(`   browser redirected to ${dim(back)}`);
        const result = await satim.confirm(reg.getOrderId(), 2500);
        console.log(`   confirm -> successful=${ok(result.isSuccessful())} amount=${result.getAmount()} DZD`
            + ` approval=${result.getApprovalCode()}`);
        console.log(`   PII redacted in raw: Pan=${result.getRawResponse().Pan} (accessor: ${result.getCardPan()})`);
    }

    step(2, "Amount tampering is rejected");
    {
        const reg = await register("CART-1002", 3000);
        await payWith(reg.getUrl(), "6280581000000000");
        try {
            await satim.confirm(reg.getOrderId(), 30); // attacker claims 30 DZD
            console.log(bad("   confirm accepted a wrong amount — BUG"));
        } catch (err) {
            console.log(`   confirm(30) -> ${ok("threw")}: ${err.message}`);
        }
    }

    step(3, "Declined card");
    {
        const reg = await register("CART-1003", 4000);
        await payWith(reg.getUrl(), "6280581000000001");
        const r = await satim.confirm(reg.getOrderId(), 4000);
        console.log(`   rejected=${r.isRejected()} failed=${r.isFailed()} successful=${r.isSuccessful()}`);
        console.log(`   message: ${r.getErrorMessage()}`);
    }

    step(4, "Cancelled, then expired");
    for (const [ref, pan, label] of [["CART-1004", "6280581000000004", "cancel"], ["CART-1005", "6280581000000003", "expiry"]]) {
        const reg = await register(ref, 5000);
        await payWith(reg.getUrl(), pan);
        const r = await satim.confirm(reg.getOrderId(), 5000);
        console.log(`   ${label}: cancelled=${r.isCancelled()} expired=${r.isExpired()} -> "${r.getErrorMessage()}"`);
    }

    step(5, "Pre-authorization: hold now, capture later");
    {
        // No dynamicCallbackUrl here, deliberately. confirm() is the capture
        // operation for a pre-auth, and the webhook handler calls confirm()
        // on every non-duplicate callback — so wiring a callback to a
        // pre-auth order captures the hold the instant it is placed. See
        // the note printed below.
        const reg = await satim
            .amount(7500)
            .returnUrl(`${MERCHANT}/return`)
            .safeRegisterPreAuth("CART-1006");
        const orderId = reg.getOrderId();
        ledger.set(orderId, 7500);

        await payWith(reg.getUrl(), "6280581000000005");
        const held = await satim.status(orderId);
        console.log(`   after payment:  preAuthorized=${ok(held.isPreAuthorized())} successful=${held.isSuccessful()}`);

        const captured = await satim.confirm(orderId, 7500);
        console.log(`   after confirm:  preAuthorized=${captured.isPreAuthorized()} successful=${ok(captured.isSuccessful())}`
            + ` deposited=${captured.getDepositAmount()} DZD`);
        console.log(dim("   note: confirm() captures a hold, and the webhook handler calls confirm()."));
        console.log(dim("         Verify against the real gateway before letting a callback touch a pre-auth."));
    }

    step(6, "Idempotent registration");
    {
        const a = await satim.amount(1200).returnUrl(`${MERCHANT}/return`).safeRegister("CART-1007");
        const b = await satim.amount(1200).returnUrl(`${MERCHANT}/return`).safeRegister("CART-1007");
        console.log(`   two safeRegister calls -> same orderId: ${a.getOrderId() === b.getOrderId() ? ok("yes") : bad("no")}`);
    }

    step(7, "Duplicate order with a conflicting amount");
    {
        try {
            await satim.amount(9900).returnUrl(`${MERCHANT}/return`).orderNumber("CART1007").register();
            await satim.amount(1100).returnUrl(`${MERCHANT}/return`).orderNumber("CART1007").register();
            console.log(bad("   gateway accepted a conflicting duplicate — unexpected"));
        } catch (err) {
            console.log(`   second register -> ${ok(err.constructor.name)}: ${err.message.slice(0, 70)}`);
        }
    }

    step(8, "Refund and reverse");
    {
        const reg = await register("CART-1008", 6000);
        await payWith(reg.getUrl(), "6280581000000000");
        await satim.confirm(reg.getOrderId(), 6000);
        const refunded = await satim.refund(reg.getOrderId(), 6000);
        console.log(`   refund -> refunded=${ok(refunded.isRefunded())}`);

        const reg2 = await register("CART-1009", 6000);
        await payWith(reg2.getUrl(), "6280581000000000");
        const reversed = await satim.reverseOrder(reg2.getOrderId());
        console.log(`   reverse -> reversed=${ok(reversed.isReversed())}`);
    }

    step(9, "Transport faults: retry, then the circuit breaker");
    {
        // Two 503s then a real response: the SDK should retry through them.
        await fetch(`${GATEWAY}/__control`, {
            method: "POST", body: JSON.stringify({ faults: ["http503", "http503"] }),
        });
        const started = Date.now();
        const r = await satim.status([...ledger.keys()][0]);
        console.log(`   two 503s then success -> recovered in ${Date.now() - started}ms, `
            + `OrderStatus present=${ok(r.getRawResponse().OrderStatus !== undefined)}`);

        // An HTML error page served as 200 must be treated as a failure.
        await fetch(`${GATEWAY}/__control`, { method: "POST", body: JSON.stringify({ faults: ["html200"] }) });
        try {
            await satim.confirm([...ledger.keys()][0], 2500);
            console.log(bad("   HTML-as-200 was accepted — BUG"));
        } catch (err) {
            console.log(`   HTML served as 200 -> ${ok(err.errorCategory)} (${err.constructor.name})`);
        }

        // A degraded gateway must trip the breaker rather than being hammered.
        const fragile = new Satim(
            { username: "test_merchant", password: "test_password", terminalId: "E005005099" },
            new HttpClientService(false, {
                baseUrl: `${GATEWAY}/payment/rest`,
                maxRetries: 0,
                circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 500 },
            }),
        );
        const probe = [...ledger.keys()][0];
        // Two faults for two requests: the third call is refused by the
        // breaker and never reaches the server, so arming a third would
        // leave it queued and poison the recovery probe below.
        await fetch(`${GATEWAY}/__control`, {
            method: "POST", body: JSON.stringify({ faults: ["html200", "html200"] }),
        });
        const seen = [];
        for (let i = 0; i < 3; i++) {
            await fragile.status(probe).catch((e) => seen.push(e.errorCategory));
        }
        console.log(`   three degraded responses -> ${seen.join(", ")} `
            + `${seen.includes("circuit_open") ? ok("(breaker opened)") : bad("(breaker never opened)")}`);

        await new Promise((r) => setTimeout(r, 600));  // let the reset timeout elapse
        const recovered = await fragile.status(probe).then(() => true, () => false);
        console.log(`   gateway healthy again, probe admitted: ${recovered ? ok("yes") : bad("no")}`);
    }

    step(10, "Bad credentials");
    {
        const wrong = new Satim(
            { username: "nope", password: "nope", terminalId: "T1" },
            new HttpClientService(false, { baseUrl: `${GATEWAY}/payment/rest` }),
        );
        try {
            await wrong.amount(5000).returnUrl(`${MERCHANT}/return`).register();
            console.log(bad("   bad credentials accepted — BUG"));
        } catch (err) {
            console.log(`   -> ${ok(err.constructor.name)}: ${err.message}`);
        }
    }

    console.log(`\n${dim(`callbacks received: ${callbacksSeen} · orders fulfilled: ${fulfilled.size}`)}`);
    console.log(ok("\nWalkthrough complete."));
    merchantServer.close();
}

main().catch((err) => {
    console.error(bad("\nDemo failed:"), err);
    merchantServer.close();
    process.exit(1);
});

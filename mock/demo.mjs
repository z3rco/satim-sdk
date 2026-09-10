/**
 * End-to-end walkthrough of the SDK against the mock gateway.
 *
 * Drives the hosted payment page the way a browser does — posts card
 * details, answers the 3-D Secure challenge, follows redirects — so the
 * states exercised here are the ones a real customer produces.
 *
 *     node mock/gateway.mjs        # terminal 1
 *     node mock/demo.mjs           # terminal 2
 *
 * Build first (`npm run build`); this imports dist/, like a merchant does.
 */
import { createServer } from "node:http";
import { Satim, HttpClientService } from "../dist/index.js";
import { VALID_OTP } from "./scenarios.mjs";

const GATEWAY_PORT = Number(process.env.PORT ?? 8787);
const MERCHANT_PORT = Number(process.env.MERCHANT_PORT ?? 8788);
const GATEWAY = `http://localhost:${GATEWAY_PORT}`;
const MERCHANT = `http://localhost:${MERCHANT_PORT}`;

const CARD = {
    approved: "6280581000000007",
    insufficient: "6280581000000015",
    threeDSFail: "6280581000000023",
    doNotHonor: "6280581000000031",
    preAuth: "6280581000000056",
    issuerDown: "6280581000000064",
    edahabia: "5078001000000004",
};

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const step = (n, s) => console.log(`\n\x1b[1m${n}. ${s}\x1b[0m`);

const ledger = new Map();
const fulfilled = new Set();
const processed = new Set();

const satim = new Satim(
    { username: "test_merchant", password: "test_password", terminalId: "E005005099" },
    new HttpClientService(false, { baseUrl: `${GATEWAY}/payment/rest`, maxRetries: 2 }),
).allowPrivateUrls(true);

const webhook = satim.createWebhookHandler({
    onResolveAmount: (id) => ledger.get(id),
    onCheckDuplicate: (id) => processed.has(id),
    onMarkProcessed: (id) => { processed.add(id); },
});

const merchantServer = createServer(async (req, res) => {
    if (!req.url.startsWith("/callback")) { res.writeHead(404).end(); return; }
    const outcome = await webhook.inspect(`${MERCHANT}${req.url}`).catch((e) => ({ error: e }));
    if (outcome.error) {
        console.log(`   callback ${bad("threw")}: ${outcome.error.message}`);
        res.writeHead(500).end(); return;
    }
    if (!outcome.verified) {
        console.log(`   callback ${bad(outcome.reason)}`);
        res.writeHead(400).end(); return;
    }
    const { orderId, response, duplicate } = outcome.result;
    if (response.isSuccessful() && !duplicate) fulfilled.add(orderId);
    console.log(dim(`   callback: successful=${response.isSuccessful()} duplicate=${duplicate}`));
    res.writeHead(200).end();
});

const form = (fields) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
});

/**
 * Fill in the hosted payment page and clear 3-D Secure.
 *
 * @returns the redirect target on approval, or `null` when the issuer
 *          declined and the page offered a retry instead.
 */
async function pay(formUrl, pan, opts = {}) {
    const { otp = VALID_OTP, expiry = "12/30", cvv = "123", holder = "AHMED BENALI" } = opts;
    const mdOrder = new URL(formUrl).searchParams.get("mdOrder");

    let res = await fetch(`${GATEWAY}/payment/rest/__pay`, form({ mdOrder, pan, expiry, cvv, holder }));
    if (res.status === 302) return res.headers.get("location");

    const html = await res.text();
    if (html.includes("3-D Secure")) {
        // Answer the challenge, retrying the OTP the way a cardholder would.
        for (let i = 0; i < 3; i++) {
            res = await fetch(`${GATEWAY}/payment/rest/__3ds`, form({ mdOrder, otp }));
            if (res.status === 302) return res.headers.get("location");
            if (!(await res.text()).includes("3-D Secure")) return null;
        }
    }
    return null;
}

/** Submit the card form only, returning the validation error it renders. */
async function formError(formUrl, fields) {
    const mdOrder = new URL(formUrl).searchParams.get("mdOrder");
    const res = await fetch(`${GATEWAY}/payment/rest/__pay`, form({ mdOrder, ...fields }));
    return (await res.text()).match(/<div class="err">([^<]+)</)?.[1] ?? null;
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

async function main() {
    await new Promise((r) => merchantServer.listen(MERCHANT_PORT, r));
    await fetch(`${GATEWAY}/__reset`, { method: "POST" });

    step(1, "Card form validation, before any issuer is contacted");
    {
        const reg = await register("CART-2001", 2500);
        const cases = [
            ["fails Luhn", { pan: "6280581000000000", expiry: "12/30", cvv: "123", holder: "A B" }],
            ["unknown brand", { pan: "4111111111111111", expiry: "12/30", cvv: "123", holder: "A B" }],
            ["expired card", { pan: CARD.approved, expiry: "01/20", cvv: "123", holder: "A B" }],
            ["month 13", { pan: CARD.approved, expiry: "13/30", cvv: "123", holder: "A B" }],
            ["short CVV", { pan: CARD.approved, expiry: "12/30", cvv: "1", holder: "A B" }],
            ["no holder", { pan: CARD.approved, expiry: "12/30", cvv: "123", holder: "" }],
        ];
        for (const [label, fields] of cases) {
            console.log(`   ${label.padEnd(14)} -> ${ok(await formError(reg.getUrl(), fields))}`);
        }
    }

    step(2, "Approved payment, through the 3-D Secure challenge");
    {
        const reg = await register("CART-2002", 2500);
        const back = await pay(reg.getUrl(), CARD.approved);
        console.log(`   redirected to ${dim(back)}`);
        const r = await satim.confirm(reg.getOrderId(), 2500);
        console.log(`   confirm -> successful=${ok(r.isSuccessful())} amount=${r.getAmount()} DZD`
            + ` approval=${r.getApprovalCode()}`);
        console.log(`   card=${r.getCardPan()} holder=${r.getCardHolderName()} exp=${r.getCardExpiry()}`);
    }

    step(3, "Wrong OTP three times — the attempt is refused");
    {
        const reg = await register("CART-2003", 3000);
        await pay(reg.getUrl(), CARD.approved, { otp: "000000" });
        const r = await satim.confirm(reg.getOrderId(), 3000);
        console.log(`   rejected=${ok(r.isRejected())} message="${r.getErrorMessage()}"`);
    }

    step(4, "Declined, then the customer retries with a good card");
    {
        // The scenario that broke the webhook handler: a failed attempt must
        // not mark the order processed, or the successful retry arrives as a
        // duplicate and the paid customer is never fulfilled.
        const reg = await register("CART-2004", 4000);
        const orderId = reg.getOrderId();

        await pay(reg.getUrl(), CARD.insufficient);
        const declined = await satim.status(orderId);
        console.log(`   attempt 1 (insufficient funds): rejected=${declined.isRejected()}`
            + ` fulfilled=${fulfilled.has(orderId) ? bad("yes — wrong") : ok("no — correct")}`);

        const back = await pay(reg.getUrl(), CARD.approved);
        console.log(`   attempt 2 (good card): redirected=${ok(Boolean(back))}`);
        const r = await satim.confirm(orderId, 4000);
        console.log(`   confirm -> successful=${ok(r.isSuccessful())}`
            + ` fulfilled=${fulfilled.has(orderId) ? ok("yes — correct") : bad("no — BUG")}`);
    }

    step(5, "Issuer never answers — the order stays pending");
    {
        const reg = await register("CART-2005", 5000);
        await pay(reg.getUrl(), CARD.issuerDown);
        const r = await satim.status(reg.getOrderId());
        console.log(`   pending=${ok(r.isPending())} successful=${r.isSuccessful()} failed=${r.isFailed()}`);
        console.log(dim("   pending is never marked processed, so a later callback can still settle it"));
    }

    step(6, "Cardholder cancels on the payment page");
    {
        const reg = await register("CART-2006", 5000);
        const mdOrder = new URL(reg.getUrl()).searchParams.get("mdOrder");
        await fetch(`${GATEWAY}/payment/rest/__cancel`, form({ mdOrder }));
        const r = await satim.confirm(reg.getOrderId(), 5000);
        console.log(`   cancelled=${ok(r.isCancelled())} message="${r.getErrorMessage()}"`);
    }

    step(7, "Session expires before the customer pays");
    {
        const reg = await register("CART-2007", 5000);
        await fetch(`${GATEWAY}/__expire?orderId=${reg.getOrderId()}`, { method: "POST" });
        await pay(reg.getUrl(), CARD.approved);
        const r = await satim.confirm(reg.getOrderId(), 5000);
        console.log(`   expired=${ok(r.isExpired())} message="${r.getErrorMessage()}"`);
    }

    step(8, "Edahabia — frictionless, no challenge");
    {
        const reg = await register("CART-2008", 1800);
        const back = await pay(reg.getUrl(), CARD.edahabia);
        console.log(`   approved without a challenge: ${ok(Boolean(back))}`);
        const r = await satim.confirm(reg.getOrderId(), 1800);
        console.log(`   successful=${ok(r.isSuccessful())} card=${r.getCardPan()}`);
    }

    step(9, "Amount tampering is rejected");
    {
        const reg = await register("CART-2009", 3000);
        await pay(reg.getUrl(), CARD.approved);
        try {
            await satim.confirm(reg.getOrderId(), 30);
            console.log(bad("   accepted a wrong amount — BUG"));
        } catch (err) {
            console.log(`   confirm(30) -> ${ok("threw")}: ${err.message}`);
        }
    }

    step(10, "Pre-authorization: hold, then capture");
    {
        const reg = await satim.amount(7500).returnUrl(`${MERCHANT}/return`).safeRegisterPreAuth("CART-2010");
        ledger.set(reg.getOrderId(), 7500);
        await pay(reg.getUrl(), CARD.preAuth);
        const held = await satim.status(reg.getOrderId());
        console.log(`   after payment: preAuthorized=${ok(held.isPreAuthorized())}`);
        const captured = await satim.confirm(reg.getOrderId(), 7500);
        console.log(`   after confirm: successful=${ok(captured.isSuccessful())}`
            + ` deposited=${captured.getDepositAmount()} DZD`);
    }

    step(11, "Refund and reverse");
    {
        const a = await register("CART-2011", 6000);
        await pay(a.getUrl(), CARD.approved);
        await satim.confirm(a.getOrderId(), 6000);
        console.log(`   refund  -> refunded=${ok((await satim.refund(a.getOrderId(), 6000)).isRefunded())}`);

        const b = await register("CART-2012", 6000);
        await pay(b.getUrl(), CARD.approved);
        console.log(`   reverse -> reversed=${ok((await satim.reverseOrder(b.getOrderId())).isReversed())}`);
    }

    step(12, "Transport faults: retry, breaker, recovery");
    {
        await fetch(`${GATEWAY}/__control`, { method: "POST", body: JSON.stringify({ faults: ["http503", "http503"] }) });
        const probe = [...ledger.keys()][0];
        const started = Date.now();
        await satim.status(probe);
        console.log(`   two 503s then success -> recovered in ${Date.now() - started}ms`);

        const fragile = new Satim(
            { username: "test_merchant", password: "test_password", terminalId: "E005005099" },
            new HttpClientService(false, {
                baseUrl: `${GATEWAY}/payment/rest`, maxRetries: 0,
                circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 500 },
            }),
        );
        // Two faults for two requests; the third call is refused by the
        // breaker and never reaches the server.
        await fetch(`${GATEWAY}/__control`, { method: "POST", body: JSON.stringify({ faults: ["html200", "html200"] }) });
        const seen = [];
        for (let i = 0; i < 3; i++) await fragile.status(probe).catch((e) => seen.push(e.errorCategory));
        console.log(`   degraded gateway -> ${seen.join(", ")} `
            + `${seen.includes("circuit_open") ? ok("(breaker opened)") : bad("(never opened)")}`);
        await new Promise((r) => setTimeout(r, 600));
        console.log(`   after reset timeout -> `
            + `${await fragile.status(probe).then(() => ok("probe admitted"), () => bad("still refused"))}`);
    }

    step(13, "Bad credentials");
    {
        const wrong = new Satim(
            { username: "nope", password: "nope", terminalId: "T1" },
            new HttpClientService(false, { baseUrl: `${GATEWAY}/payment/rest` }),
        ).allowPrivateUrls(true);
        await wrong.amount(5000).returnUrl(`${MERCHANT}/return`).register().then(
            () => console.log(bad("   accepted — BUG")),
            (e) => console.log(`   -> ${ok(e.constructor.name)}: ${e.message}`),
        );
    }

    console.log(ok("\nWalkthrough complete."));
    merchantServer.close();
}

main().catch((err) => {
    console.error(bad("\nDemo failed:"), err);
    merchantServer.close();
    process.exit(1);
});

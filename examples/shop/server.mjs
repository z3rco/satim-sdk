/**
 * Demo storefront — a real merchant backend built on the SDK.
 *
 * Serves a shop, takes a cart to checkout, registers the order through the
 * SDK, redirects the customer to the gateway's hosted payment page,
 * receives the server-to-server callback, and confirms the payment. Every
 * SDK call and every gateway answer is logged to the console (and mirrored
 * to a live panel in the browser).
 *
 *     npm run shop          # starts the mock gateway and this server
 *     open http://localhost:8788
 *
 * The SDK refuses loopback and private URLs for returnUrl / failUrl /
 * dynamicCallbackUrl, because those are handed to the gateway and pointing
 * them inward is how SSRF happens. `allowPrivateUrls(true)` below is the
 * documented development escape hatch — never set it in production.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { Satim, HttpClientService, SatimError } from "../../dist/index.js";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 8787);
const SHOP_PORT = Number(process.env.SHOP_PORT ?? 8788);
const HOSTNAME = process.env.SHOP_HOSTNAME ?? "localhost";
const SHOP_ORIGIN = `http://${HOSTNAME}:${SHOP_PORT}`;
const GATEWAY = `http://localhost:${GATEWAY_PORT}`;

// ── Console logging ──────────────────────────────────────────────────

const C = {
    reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
    green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
    blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};

/** Subscribers to the browser-side live log panel. */
const logSubscribers = new Set();

function emit(line, kind = "info") {
    const stamp = new Date().toISOString().slice(11, 23);
    const colour = { sdk: C.cyan, gateway: C.magenta, ok: C.green, err: C.red, warn: C.yellow }[kind] ?? "";
    console.log(`${C.dim}${stamp}${C.reset} ${colour}${line}${C.reset}`);
    const payload = JSON.stringify({ stamp, line: stripAnsi(line), kind });
    for (const res of logSubscribers) res.write(`data: ${payload}\n\n`);
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const open = (title) => emit(`${C.bold}┌ ${title}${C.reset}`);
const line = (text, kind) => emit(`│ ${text}`, kind);
const close = (text, kind = "ok") => { emit(`└ ${text}`, kind); emit(""); };

// ── Catalogue and order book ─────────────────────────────────────────

// SATIM requires at least 50 DA and whole dinars, so every price is an integer.
const PRODUCTS = [
    { sku: "DZ-TEA", name: "Thé à la menthe (500g)", price: 850, emoji: "🍵" },
    { sku: "DZ-DAT", name: "Deglet Nour (1kg)", price: 1600, emoji: "🌴" },
    { sku: "DZ-OIL", name: "Huile d'olive de Kabylie (1L)", price: 2400, emoji: "🫒" },
    { sku: "DZ-HON", name: "Miel de jujubier (250g)", price: 4500, emoji: "🍯" },
    { sku: "DZ-RUG", name: "Tapis berbère fait main", price: 28000, emoji: "🧶" },
];

/** ref -> order. The merchant's source of truth for what an order should cost. */
const orders = new Map();
/** gateway orderId -> ref. */
const byGatewayId = new Map();
/** Processed markers for webhook idempotency (Redis in production). */
const processed = new Set();

let sequence = 1000;
const nextRef = () => `ORD-${++sequence}`;

// ── The SDK ──────────────────────────────────────────────────────────

const satim = new Satim(
    {
        username: process.env.SATIM_USERNAME ?? "test_merchant",
        password: process.env.SATIM_PASSWORD ?? "test_password",
        terminalId: process.env.SATIM_TERMINAL_ID ?? "E005005099",
    },
    new HttpClientService(false, { baseUrl: `${GATEWAY}/payment/rest`, maxRetries: 2 }),
);

const webhook = satim.createWebhookHandler({
    // The expected amount comes from the merchant's own records, never from
    // the request. This is what makes amount verification meaningful.
    onResolveAmount: (gatewayOrderId) => orders.get(byGatewayId.get(gatewayOrderId))?.total,
    onCheckDuplicate: (gatewayOrderId) => processed.has(gatewayOrderId),
    onMarkProcessed: (gatewayOrderId) => { processed.add(gatewayOrderId); },
});

// ── Routes ───────────────────────────────────────────────────────────

/** POST /api/checkout — register the order and hand back the payment URL. */
async function checkout(body) {
    const items = (body.items ?? [])
        .map((i) => ({ ...PRODUCTS.find((p) => p.sku === i.sku), qty: Math.max(1, Number(i.qty) || 1) }))
        .filter((i) => i.sku);
    if (!items.length) throw new Error("Cart is empty");

    const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    const ref = nextRef();
    const order = { ref, items, total, status: "PENDING", gatewayOrderId: null, formUrl: null, history: [] };
    orders.set(ref, order);

    open(`CHECKOUT ${ref}`);
    line(`cart: ${items.map((i) => `${i.qty}x ${i.name}`).join(", ")}`);
    line(`total: ${C.bold}${total} DZD${C.reset}`);
    line(`satim.amount(${total}).returnUrl(...).dynamicCallbackUrl(...).safeRegister("${ref}")`, "sdk");

    const started = Date.now();
    const registration = await satim
        .allowPrivateUrls(true)   // development only — see the file header
        .amount(total)
        .currency("DZD")
        .language("FR")
        .description(`Commande ${ref}`)
        .returnUrl(`${SHOP_ORIGIN}/return`)
        .failUrl(`${SHOP_ORIGIN}/return`)
        .dynamicCallbackUrl(`${SHOP_ORIGIN}/callback`)
        .userDefinedField("ref", ref)
        .safeRegister(ref);

    order.gatewayOrderId = registration.getOrderId();
    order.formUrl = registration.getUrl();
    byGatewayId.set(order.gatewayOrderId, ref);
    order.history.push({ at: Date.now(), event: "registered" });

    line(`← orderId ${C.bold}${order.gatewayOrderId}${C.reset} ${C.dim}(${Date.now() - started}ms)${C.reset}`, "gateway");
    line(`← formUrl ${order.formUrl}`, "gateway");
    close(`redirecting customer to the hosted payment page`);

    return { ref, total, formUrl: order.formUrl };
}

/**
 * POST /callback — the gateway's server-to-server notification.
 *
 * This is the reliable path. It arrives whether or not the customer's
 * browser ever makes it back, which is why fulfilment hangs off it.
 */
async function handleCallback(req, url) {
    open(`WEBHOOK ${req.method} ${url.pathname}${url.search}`);
    line(`payload is untrusted — handler.inspect() re-fetches live state`, "sdk");

    let outcome;
    try {
        outcome = await webhook.inspect(`${SHOP_ORIGIN}${req.url}`);
    } catch (err) {
        line(`threw: ${err.constructor.name}: ${err.message}`, "err");
        close("responding 500 so the gateway redelivers", "err");
        return { status: 500 };
    }

    if (!outcome.verified) {
        const status = { invalid_source: 400, unknown_order: 404, rate_limited: 429 }[outcome.reason];
        line(`rejected: ${outcome.reason}`, "warn");
        close(`responding ${status}${status === 429 ? " so the gateway redelivers" : ""}`, "warn");
        return { status };
    }

    const { orderId, response, duplicate } = outcome.result;
    const ref = byGatewayId.get(orderId);
    const order = orders.get(ref);

    line(`satim.confirm("${orderId}", ${order.total}) — amount verified against our records`, "sdk");
    line(`← OrderStatus=${response.getRawResponse().OrderStatus ?? "(none)"} `
        + `successful=${response.isSuccessful()} duplicate=${duplicate}`, "gateway");

    if (response.isSuccessful() && !duplicate) {
        order.status = "PAID";
        order.paidAt = Date.now();
        order.pan = response.getCardPan();
        order.approvalCode = response.getApprovalCode();
        order.history.push({ at: Date.now(), event: "paid (webhook)" });
        close(`${C.green}${ref} marked PAID${C.reset} — approval ${order.approvalCode}, card ${order.pan}`);
    } else if (duplicate) {
        order.history.push({ at: Date.now(), event: "duplicate callback ignored" });
        close(`${ref} already processed — not fulfilling again`, "warn");
    } else {
        order.status = "FAILED";
        order.failureReason = response.getErrorMessage();
        order.history.push({ at: Date.now(), event: `failed: ${order.failureReason}` });
        close(`${ref} failed: ${order.failureReason}`, "err");
    }
    return { status: 200 };
}

/**
 * GET /return — where the customer's browser lands.
 *
 * Untrusted: anyone can hit this URL with any orderId. It is only used to
 * decide what to render; the webhook above is what actually fulfils.
 */
async function handleReturn(url) {
    const gatewayOrderId = url.searchParams.get("orderId");
    const ref = byGatewayId.get(gatewayOrderId);
    const order = orders.get(ref);

    open(`RETURN customer is back — orderId=${gatewayOrderId}`);
    if (!order) {
        close("unknown order, nothing to show", "warn");
        return { ref: null };
    }

    if (order.status === "PAID") {
        // The callback usually wins the race; no need to acknowledge twice.
        line(`already PAID by the webhook — reading state with satim.status()`, "sdk");
        const state = await satim.status(gatewayOrderId);
        line(`← successful=${state.isSuccessful()} amount=${state.getAmount()} DZD`, "gateway");
        close(`showing the receipt for ${ref}`);
        return { ref };
    }

    line(`not yet settled here — satim.confirm("${gatewayOrderId}", ${order.total})`, "sdk");
    try {
        const result = await satim.confirm(gatewayOrderId, order.total);
        line(`← successful=${result.isSuccessful()} OrderStatus=${result.getRawResponse().OrderStatus ?? "(none)"}`, "gateway");
        if (result.isSuccessful()) {
            order.status = "PAID";
            order.pan = result.getCardPan();
            order.approvalCode = result.getApprovalCode();
            order.history.push({ at: Date.now(), event: "paid (return)" });
            close(`${C.green}${ref} marked PAID${C.reset}`);
        } else {
            order.status = "FAILED";
            order.failureReason = result.getErrorMessage();
            order.history.push({ at: Date.now(), event: `failed: ${order.failureReason}` });
            close(`${ref} failed: ${order.failureReason}`, "err");
        }
    } catch (err) {
        order.status = "FAILED";
        order.failureReason = err instanceof SatimError ? err.message : "Unexpected error";
        line(`${err.constructor.name}: ${err.message}`, "err");
        close(`${ref} failed`, "err");
    }
    return { ref };
}

/** POST /api/refund — refund a paid order. */
async function refund(body) {
    const order = orders.get(body.ref);
    if (!order || order.status !== "PAID") throw new Error("Order is not refundable");

    open(`REFUND ${order.ref}`);
    line(`satim.refund("${order.gatewayOrderId}", ${order.total})`, "sdk");
    const result = await satim.refund(order.gatewayOrderId, order.total);
    line(`← refunded=${result.isRefunded()}`, "gateway");
    order.status = result.isRefunded() ? "REFUNDED" : order.status;
    order.history.push({ at: Date.now(), event: "refunded" });
    close(`${order.ref} refunded`);
    return { ok: true };
}

const publicOrder = (o) => ({
    ref: o.ref, total: o.total, status: o.status, items: o.items,
    gatewayOrderId: o.gatewayOrderId, pan: o.pan, approvalCode: o.approvalCode,
    failureReason: o.failureReason, history: o.history,
});

// ── HTTP plumbing ────────────────────────────────────────────────────

async function readJson(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
}

const json = (res, payload, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url, SHOP_ORIGIN);

    try {
        if (url.pathname === "/" || url.pathname === "/index.html") {
            const html = await readFile(fileURLToPath(new URL("./public/index.html", import.meta.url)));
            res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
            return res.end(html);
        }

        // Live log feed for the browser panel.
        if (url.pathname === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            res.write(": connected\n\n");
            logSubscribers.add(res);
            req.on("close", () => logSubscribers.delete(res));
            return;
        }

        if (url.pathname === "/api/products") return json(res, PRODUCTS);
        if (url.pathname === "/api/orders") {
            return json(res, [...orders.values()].reverse().map(publicOrder));
        }
        if (url.pathname === "/api/checkout" && req.method === "POST") {
            return json(res, await checkout(await readJson(req)));
        }
        if (url.pathname === "/api/refund" && req.method === "POST") {
            return json(res, await refund(await readJson(req)));
        }
        if (url.pathname === "/callback") {
            const { status } = await handleCallback(req, url);
            res.writeHead(status);
            return res.end();
        }
        if (url.pathname === "/return") {
            const { ref } = await handleReturn(url);
            res.writeHead(302, { Location: `/?order=${ref ?? ""}` });
            return res.end();
        }

        res.writeHead(404);
        res.end("Not found");
    } catch (err) {
        emit(`${C.red}unhandled: ${err.stack}${C.reset}`, "err");
        json(res, { error: err.message }, 400);
    }
});

// ── Boot ─────────────────────────────────────────────────────────────

async function checkHostname() {
    try {
        await lookup(HOSTNAME);
        return true;
    } catch {
        console.log(`\n${C.yellow}${HOSTNAME} does not resolve on this machine.${C.reset}`);
        console.log(`Unset SHOP_HOSTNAME to fall back to localhost.\n`);
        return false;
    }
}

if (!(await checkHostname())) process.exit(1);

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(`\n  port ${SHOP_PORT} is already in use — another shop is probably running.`);
        console.error(`  stop it, or: SHOP_PORT=9000 npm run shop\n`);
        process.exit(1);
    }
    throw err;
});

server.listen(SHOP_PORT, "::", () => {
    console.log(`\n${C.bold}  Demo shop${C.reset}`);
    console.log(`  storefront  ${C.cyan}${SHOP_ORIGIN}${C.reset}`);
    console.log(`  gateway     ${C.magenta}${GATEWAY}${C.reset} ${C.dim}(mock)${C.reset}`);
    console.log(`  ${C.dim}every SDK call and gateway response is logged below${C.reset}\n`);
});

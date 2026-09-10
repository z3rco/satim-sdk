/**
 * Mock SATIM payment gateway.
 *
 * Speaks the same REST contract as `cib.satim.dz` / `test.satim.dz` so the
 * full payment lifecycle — register, hosted form, confirm, status, refund,
 * reverse, and the server-to-server callback — can be exercised locally,
 * with no merchant credentials and no network.
 *
 * What it is faithful about, because the SDK depends on it:
 *
 * - `application/x-www-form-urlencoded` request bodies, JSON responses.
 * - Numeric `errorCode` / `OrderStatus` on the wire by default. The live
 *   gateway answers `{"errorCode":5,"errorMessage":"Access denied"}` — a
 *   JSON number, not a string. Set `WIRE_STYLE=string` to emit strings and
 *   check the SDK copes with both.
 * - The two spellings: `register.do` returns lowercase `errorCode`, while
 *   order-management endpoints return capitalised `ErrorCode`/`OrderStatus`.
 * - `confirm` reads `mdOrder`; `status`, `refund` and `reverse` read `orderId`.
 * - A declined, cancelled or expired attempt carries **no** `OrderStatus`
 *   at all — only `actionCode` and friends.
 * - `externalRequestId` deduplicates: replaying one returns the original
 *   order rather than creating a second.
 *
 * What it does not do: real 3-D Secure, real settlement, real bank
 * decisioning. Those need a certified merchant account. See mock/README.md.
 *
 *     node mock/gateway.mjs            # listens on :8787
 *     PORT=9000 node mock/gateway.mjs
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { TEST_CARDS, CARDHOLDER, FAULTS, DUPLICATE_ORDER } from "./scenarios.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "::";
const WIRE_STYLE = process.env.WIRE_STYLE === "string" ? "string" : "numeric";
const LOG = process.env.QUIET !== "1";

/** Credentials this mock accepts. Override to test the failure path. */
const CREDENTIALS = {
    userName: process.env.MOCK_USERNAME ?? "test_merchant",
    password: process.env.MOCK_PASSWORD ?? "test_password",
};

// ── State ────────────────────────────────────────────────────────────

/** orderId -> order. In-memory only; restarting the server clears everything. */
const orders = new Map();
/** externalRequestId -> orderId, for idempotent registration. */
const byRequestId = new Map();
/** orderNumber -> orderId, for duplicate detection. */
const byOrderNumber = new Map();
/** Faults armed via POST /__control, consumed one response at a time. */
let armedFaults = [];

const log = (...a) => { if (LOG) console.log("[mock]", ...a); };

// ── Wire helpers ─────────────────────────────────────────────────────

/**
 * Emit a numeric-looking field the way the configured wire style wants it.
 * The SDK must handle both; defaulting to numeric keeps it honest.
 */
const wire = (value) => (WIRE_STYLE === "string" ? String(value) : Number(value));

function sendJson(res, payload, status = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json;charset=UTF-8",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}

function sendHtml(res, html, status = 200) {
    res.writeHead(status, { "Content-Type": "text/html;charset=UTF-8" });
    res.end(html);
}

/** Read a form-encoded body into a plain object. */
async function readForm(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/** Apply the next armed fault, if any. Returns true when the response was consumed. */
function applyFault(res) {
    const name = armedFaults.shift();
    if (!name) return false;
    const fault = FAULTS[name];
    if (!fault) return false;
    log(`injecting fault: ${name}`);
    if (fault.hangMs) {
        setTimeout(() => { try { res.destroy(); } catch { /* client already gone */ } }, fault.hangMs);
        return true;
    }
    res.writeHead(fault.status, { "Content-Type": fault.contentType });
    res.end(fault.body);
    return true;
}

// ── Gateway error shapes ─────────────────────────────────────────────

const ACCESS_DENIED = { errorCode: 5, errorMessage: "Access denied" };
const UNKNOWN_ORDER = { errorCode: 6, errorMessage: "Unknown order id" };
const missingParam = (name) => ({ errorCode: 4, errorMessage: `Missing required parameter: ${name}` });

/** Order-management endpoints capitalise the error fields. */
const capitalised = (err) => ({ ErrorCode: wire(err.errorCode), ErrorMessage: err.errorMessage });

function authOk(form) {
    return form.userName === CREDENTIALS.userName && form.password === CREDENTIALS.password;
}

// ── Endpoints ────────────────────────────────────────────────────────

/** `/register.do` and `/registerPreAuth.do`. */
function handleRegister(form, res, { preAuth }) {
    for (const field of ["orderNumber", "amount", "currency", "returnUrl"]) {
        if (!form[field]) return sendJson(res, { ...missingParam(field), errorCode: wire(4) });
    }

    // Replaying an externalRequestId must return the original order, never
    // a second one. This is what makes the SDK's safeRegister() retry-safe.
    const requestId = form.externalRequestId;
    if (requestId && byRequestId.has(requestId)) {
        const existing = orders.get(byRequestId.get(requestId));
        log(`register: replaying externalRequestId ${requestId} -> ${existing.orderId}`);
        return sendJson(res, { orderId: existing.orderId, formUrl: existing.formUrl, errorCode: wire(0) });
    }

    // Same orderNumber for a different amount is a genuine conflict.
    const clash = byOrderNumber.get(form.orderNumber);
    if (clash) {
        const previous = orders.get(clash);
        if (previous.amountMinor !== Number(form.amount) || previous.currency !== form.currency) {
            log(`register: duplicate orderNumber ${form.orderNumber}`);
            return sendJson(res, { ...DUPLICATE_ORDER, errorCode: wire(DUPLICATE_ORDER.errorCode) });
        }
        return sendJson(res, { orderId: previous.orderId, formUrl: previous.formUrl, errorCode: wire(0) });
    }

    const orderId = randomUUID();
    const order = {
        orderId,
        orderNumber: form.orderNumber,
        amountMinor: Number(form.amount),
        currency: form.currency,
        returnUrl: form.returnUrl,
        failUrl: form.failUrl || form.returnUrl,
        description: form.description,
        language: form.language ?? "FR",
        jsonParams: form.jsonParams,
        dynamicCallbackUrl: form.dynamicCallbackUrl,
        externalRequestId: requestId,
        preAuth,
        orderStatus: "0",          // registered, not paid
        outcome: null,             // set once a card is submitted
        depositAmountMinor: 0,
        formUrl: `http://localhost:${PORT}/payment/merchants/mockshop/payment_fr.html?mdOrder=${orderId}`,
    };
    orders.set(orderId, order);
    byOrderNumber.set(order.orderNumber, orderId);
    if (requestId) byRequestId.set(requestId, orderId);

    log(`register${preAuth ? "PreAuth" : ""}: ${orderId} for ${order.amountMinor} minor units`);
    return sendJson(res, { orderId, formUrl: order.formUrl, errorCode: wire(0) });
}

/**
 * Build the order-management response body.
 *
 * A resolved-but-failed attempt deliberately omits `OrderStatus`; that is
 * what the real gateway does, and the SDK's predicates depend on it.
 */
function orderPayload(order) {
    const outcome = order.outcome;
    const base = {
        ErrorCode: wire(0),
        OrderNumber: order.orderNumber,
        Amount: wire(order.amountMinor),
        currency: order.currency,
        depositAmount: wire(order.depositAmountMinor),
    };

    if (!outcome) {
        // Registered but nobody has paid yet.
        return { ...base, OrderStatus: wire(order.orderStatus) };
    }

    if (outcome.orderStatus !== null) {
        return {
            ...base,
            ...CARDHOLDER,
            Pan: `${order.pan.slice(0, 6)}****${order.pan.slice(-4)}`,
            OrderStatus: wire(order.orderStatus),
            actionCode: wire(outcome.actionCode),
            actionCodeDescription: outcome.actionCodeDescription,
            approvalCode: outcome.approvalCode,
            params: { respCode: outcome.respCode, respCode_desc: outcome.respCodeDesc },
        };
    }

    // Declined / cancelled / expired: no OrderStatus at all.
    const failed = {
        ...base,
        ...CARDHOLDER,
        Pan: `${order.pan.slice(0, 6)}****${order.pan.slice(-4)}`,
        actionCode: wire(outcome.actionCode),
        actionCodeDescription: outcome.actionCodeDescription,
        ErrorMessage: outcome.errorMessage,
    };
    delete failed.OrderStatus;
    if (outcome.respCode) failed.params = { respCode: outcome.respCode, respCode_desc: outcome.respCodeDesc };
    return failed;
}

/** `/public/acknowledgeTransaction.do` — confirm and deposit. */
function handleConfirm(form, res) {
    const order = orders.get(form.mdOrder);
    if (!order) return sendJson(res, capitalised(UNKNOWN_ORDER));

    // Capture. A straight sale deposits on confirm; a pre-authorized hold
    // ("1") is captured by the same call and becomes deposited ("2"),
    // which is the flow that produces a second callback for one order.
    if (order.outcome && (order.outcome.orderStatus === "2" || order.orderStatus === "1")) {
        order.orderStatus = "2";
        order.depositAmountMinor = order.amountMinor;
    }
    log(`confirm: ${order.orderId} -> OrderStatus ${order.outcome ? order.orderStatus : "0"}`);
    return sendJson(res, orderPayload(order));
}

/** `/getOrderStatus.do` — idempotent read. */
function handleStatus(form, res) {
    const order = orders.get(form.orderId);
    if (!order) return sendJson(res, capitalised(UNKNOWN_ORDER));
    return sendJson(res, orderPayload(order));
}

/** `/refund.do`. */
function handleRefund(form, res) {
    const order = orders.get(form.orderId);
    if (!order) return sendJson(res, capitalised(UNKNOWN_ORDER));
    if (order.orderStatus !== "2") {
        return sendJson(res, { ErrorCode: wire(7), ErrorMessage: "Order is not in a refundable state" });
    }
    order.orderStatus = "4";
    order.depositAmountMinor = Math.max(0, order.depositAmountMinor - Number(form.amount ?? 0));
    log(`refund: ${order.orderId} -> refunded`);
    return sendJson(res, orderPayload(order));
}

/** `/reverse.do` — void before settlement. */
function handleReverse(form, res) {
    const order = orders.get(form.orderId);
    if (!order) return sendJson(res, capitalised(UNKNOWN_ORDER));
    order.orderStatus = "3";
    order.depositAmountMinor = 0;
    log(`reverse: ${order.orderId} -> reversed`);
    return sendJson(res, orderPayload(order));
}

// ── Hosted payment page ──────────────────────────────────────────────

function paymentPage(order) {
    const rows = Object.entries(TEST_CARDS).map(([pan, card]) => `
        <label class="card">
          <input type="radio" name="pan" value="${pan}"${pan.endsWith("0000") ? " checked" : ""}>
          <code>${pan}</code> <span>${card.label}</span>
        </label>`).join("");
    return `<!doctype html><meta charset="utf-8"><title>SATIM (mock) — paiement</title>
<style>
 body{font:15px system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#111}
 h1{font-size:20px} .amt{font-size:28px;font-weight:600;margin:8px 0 24px}
 .card{display:block;padding:10px 12px;border:1px solid #ddd;border-radius:8px;margin-bottom:8px;cursor:pointer}
 .card:hover{background:#f6f6f6} code{font-weight:600} span{color:#555}
 button{margin-top:16px;padding:10px 20px;font-size:15px;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer}
 .note{margin-top:24px;color:#666;font-size:13px;border-top:1px solid #eee;padding-top:12px}
</style>
<h1>Paiement sécurisé — <em>mock gateway</em></h1>
<div class="amt">${(order.amountMinor / 100).toFixed(2)} DZD</div>
<div>Commande <code>${order.orderNumber}</code>${order.description ? ` — ${order.description}` : ""}</div>
<form method="POST" action="/payment/rest/__pay">
  <input type="hidden" name="mdOrder" value="${order.orderId}">
  <h3>Choisissez une carte de test</h3>
  ${rows}
  <button type="submit">Payer</button>
</form>
<p class="note">This page stands in for SATIM's hosted form. The card you pick decides the outcome.</p>`;
}

/**
 * Resolve an order from the chosen test card, notify the merchant's
 * callback, then redirect the browser back like the real gateway does.
 */
async function handlePay(form, res) {
    const order = orders.get(form.mdOrder);
    if (!order) return sendHtml(res, "<h1>Unknown order</h1>", 404);

    const card = TEST_CARDS[form.pan];
    if (!card) return sendHtml(res, "<h1>Unknown test card</h1>", 400);

    order.pan = form.pan;
    order.outcome = card;
    if (card.orderStatus !== null) {
        order.orderStatus = card.orderStatus;
        // A pre-auth holds funds; a straight sale is captured by confirm().
        if (card.orderStatus === "2" && !order.preAuth) order.depositAmountMinor = 0;
    }
    log(`pay: ${order.orderId} with ${form.pan} -> ${card.label}`);

    // Server-to-server callback, fired before the browser redirect — the
    // real gateway does the same, which is why the two can race.
    if (order.dynamicCallbackUrl) {
        const target = `${order.dynamicCallbackUrl}${order.dynamicCallbackUrl.includes("?") ? "&" : "?"}orderId=${order.orderId}`;
        try {
            const response = await fetch(target, { method: "POST" });
            log(`callback -> ${target} (HTTP ${response.status})`);
        } catch (err) {
            log(`callback failed: ${err.message}`);
        }
    }

    const back = card.orderStatus !== null ? order.returnUrl : order.failUrl;
    const location = `${back}${back.includes("?") ? "&" : "?"}orderId=${order.orderId}`;
    res.writeHead(302, { Location: location });
    res.end();
}

// ── Router ───────────────────────────────────────────────────────────

const REST = {
    "/payment/rest/register.do": (form, res) => handleRegister(form, res, { preAuth: false }),
    "/payment/rest/registerPreAuth.do": (form, res) => handleRegister(form, res, { preAuth: true }),
    "/payment/rest/public/acknowledgeTransaction.do": handleConfirm,
    "/payment/rest/getOrderStatus.do": handleStatus,
    "/payment/rest/refund.do": handleRefund,
    "/payment/rest/reverse.do": handleReverse,
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    // Arm transport faults: POST /__control {"faults":["http503","http503"]}
    if (path === "/__control" && req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks).toString("utf8") || "{}";
        armedFaults = (JSON.parse(body).faults ?? []).filter((f) => f in FAULTS);
        log(`armed faults: ${armedFaults.join(", ") || "(none)"}`);
        return sendJson(res, { armed: armedFaults });
    }
    if (path === "/__reset" && req.method === "POST") {
        orders.clear(); byRequestId.clear(); byOrderNumber.clear(); armedFaults = [];
        log("state reset");
        return sendJson(res, { ok: true });
    }
    // Redeliver the state-change callback for an order, the way the real
    // gateway notifies a merchant when an order advances (e.g. on capture).
    if (path === "/__notify" && req.method === "POST") {
        const order = orders.get(url.searchParams.get("orderId"));
        if (!order?.dynamicCallbackUrl) return sendJson(res, { sent: false });
        const target = `${order.dynamicCallbackUrl}${order.dynamicCallbackUrl.includes("?") ? "&" : "?"}orderId=${order.orderId}`;
        try {
            const response = await fetch(target, { method: "POST" });
            log(`callback (replay) -> ${target} (HTTP ${response.status})`);
            return sendJson(res, { sent: true, status: response.status });
        } catch (err) {
            return sendJson(res, { sent: false, error: err.message });
        }
    }
    if (path === "/__orders") {
        return sendJson(res, [...orders.values()].map((o) => ({
            orderId: o.orderId, orderNumber: o.orderNumber, amountMinor: o.amountMinor,
            orderStatus: o.orderStatus, outcome: o.outcome?.label ?? null,
        })));
    }

    // Hosted payment form.
    if (path.startsWith("/payment/merchants/") && req.method === "GET") {
        const order = orders.get(url.searchParams.get("mdOrder"));
        if (!order) return sendHtml(res, "<h1>Unknown order</h1>", 404);
        return sendHtml(res, paymentPage(order));
    }
    if (path === "/payment/rest/__pay" && req.method === "POST") {
        return handlePay(await readForm(req), res);
    }

    const handler = REST[path];
    if (!handler || req.method !== "POST") {
        return sendJson(res, { errorCode: wire(404), errorMessage: "Not found" }, 404);
    }

    // Faults are injected before anything else, so even auth never runs.
    if (applyFault(res)) return;

    const form = await readForm(req);
    if (!authOk(form)) {
        log(`auth rejected for userName=${form.userName ?? "(none)"}`);
        const shape = path.includes("register") ? ACCESS_DENIED : capitalised(ACCESS_DENIED);
        return sendJson(res, path.includes("register")
            ? { ...shape, errorCode: wire(ACCESS_DENIED.errorCode) }
            : shape);
    }
    return handler(form, res);
});

server.listen(PORT, HOST, () => {
    console.log(`[mock] SATIM gateway on http://localhost:${PORT}  (wire style: ${WIRE_STYLE})`);
    console.log(`[mock] credentials: userName=${CREDENTIALS.userName} password=${CREDENTIALS.password}`);
    console.log(`[mock] point the SDK at it with: new HttpClientService(false, { baseUrl: "http://localhost:${PORT}/payment/rest" })`);
});

export { server };

/**
 * Mock SATIM payment gateway.
 *
 * Speaks the same REST contract as `cib.satim.dz` / `test.satim.dz`, and
 * hosts a payment page that behaves like a real one: you type a card
 * number, expiry, CVV and cardholder name, it validates them, it challenges
 * you with 3-D Secure, and a declined attempt can be retried with a
 * different card on the same order.
 *
 * That last part matters. A page that just lets you pick an outcome never
 * produces the states a real integration trips over — a second attempt on
 * an order that already failed, an order left pending because the issuer
 * never answered, a session that expired mid-checkout.
 *
 * Faithful where the SDK depends on it:
 *
 * - Numeric `errorCode` / `OrderStatus` by default. The live gateway
 *   answers `{"errorCode":5,"errorMessage":"Access denied"}` — a JSON
 *   number. `WIRE_STYLE=string` flips it.
 * - `register.do` returns lowercase `errorCode`; order-management endpoints
 *   return capitalised `ErrorCode` / `OrderStatus`.
 * - `confirm` reads `mdOrder`; `status`, `refund`, `reverse` read `orderId`.
 * - A decline, cancellation or expiry carries **no** `OrderStatus` at all.
 * - `externalRequestId` deduplicates registrations.
 *
 *     node mock/gateway.mjs        # :8787
 *     LATENCY=0 node mock/gateway.mjs
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
    TEST_CARDS, VALID_OTP, MAX_OTP_ATTEMPTS, UNKNOWN_CARD, CANCELLED, EXPIRED,
    FAULTS, DUPLICATE_ORDER, luhnValid, brandOf,
} from "./scenarios.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "::";
const WIRE_STYLE = process.env.WIRE_STYLE === "string" ? "string" : "numeric";
const LOG = process.env.QUIET !== "1";
/** Simulated issuer round-trip, so timing-dependent bugs have room to appear. */
const LATENCY = Number(process.env.LATENCY ?? 350);

const CREDENTIALS = {
    userName: process.env.MOCK_USERNAME ?? "test_merchant",
    password: process.env.MOCK_PASSWORD ?? "test_password",
};

const orders = new Map();
const byRequestId = new Map();
const byOrderNumber = new Map();
let armedFaults = [];

const log = (...a) => { if (LOG) console.log("[mock]", ...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Wire helpers ─────────────────────────────────────────────────────

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

const redirect = (res, location) => { res.writeHead(302, { Location: location }); res.end(); };

async function readForm(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

function applyFault(res) {
    const name = armedFaults.shift();
    if (!name) return false;
    const fault = FAULTS[name];
    if (!fault) return false;
    log(`injecting fault: ${name}`);
    if (fault.hangMs) {
        setTimeout(() => { try { res.destroy(); } catch { /* client gone */ } }, fault.hangMs);
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
const capitalised = (err) => ({ ErrorCode: wire(err.errorCode), ErrorMessage: err.errorMessage });
const authOk = (form) =>
    form.userName === CREDENTIALS.userName && form.password === CREDENTIALS.password;

// ── REST endpoints ───────────────────────────────────────────────────

function handleRegister(form, res, { preAuth }) {
    for (const field of ["orderNumber", "amount", "currency", "returnUrl"]) {
        if (!form[field]) return sendJson(res, { ...missingParam(field), errorCode: wire(4) });
    }

    const requestId = form.externalRequestId;
    if (requestId && byRequestId.has(requestId)) {
        const existing = orders.get(byRequestId.get(requestId));
        log(`register: replaying externalRequestId ${requestId} -> ${existing.orderId}`);
        return sendJson(res, { orderId: existing.orderId, formUrl: existing.formUrl, errorCode: wire(0) });
    }

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
    const timeoutSecs = Number(form.sessionTimeoutSecs ?? 1200);
    const order = {
        orderId,
        orderNumber: form.orderNumber,
        amountMinor: Number(form.amount),
        currency: form.currency,
        returnUrl: form.returnUrl,
        failUrl: form.failUrl || form.returnUrl,
        description: form.description,
        language: (form.language ?? "FR").toUpperCase(),
        dynamicCallbackUrl: form.dynamicCallbackUrl,
        externalRequestId: requestId,
        preAuth,
        orderStatus: "0",
        outcome: null,
        depositAmountMinor: 0,
        expiresAt: Date.now() + timeoutSecs * 1000,
        attempts: [],          // one entry per card tried
        current: null,         // the attempt awaiting 3-D Secure
        card: null,            // details of the attempt that resolved the order
        formUrl: `http://localhost:${PORT}/payment/merchants/mockshop/payment.html?mdOrder=${orderId}`,
    };
    orders.set(orderId, order);
    byOrderNumber.set(order.orderNumber, orderId);
    if (requestId) byRequestId.set(requestId, orderId);

    log(`register${preAuth ? "PreAuth" : ""}: ${orderId} for ${order.amountMinor} minor units`);
    return sendJson(res, { orderId, formUrl: order.formUrl, errorCode: wire(0) });
}

function orderPayload(order) {
    const outcome = order.outcome;
    const base = {
        ErrorCode: wire(0),
        OrderNumber: order.orderNumber,
        Amount: wire(order.amountMinor),
        currency: order.currency,
        depositAmount: wire(order.depositAmountMinor),
    };
    if (!outcome) return { ...base, OrderStatus: wire(order.orderStatus) };

    const card = order.card
        ? {
            Pan: `${order.card.pan.slice(0, 6)}****${order.card.pan.slice(-4)}`,
            cardholderName: order.card.holder,
            expiration: order.card.expiration,
            Ip: order.card.ip,
        }
        : {};

    if (outcome.orderStatus !== null) {
        return {
            ...base, ...card,
            OrderStatus: wire(order.orderStatus),
            actionCode: wire(outcome.actionCode),
            actionCodeDescription: outcome.actionCodeDescription,
            approvalCode: order.card?.approvalCode,
            params: { respCode: outcome.respCode, respCode_desc: outcome.respCodeDesc },
        };
    }

    // Declined / cancelled / expired: no OrderStatus field at all.
    const failed = {
        ...base, ...card,
        actionCode: wire(outcome.actionCode),
        actionCodeDescription: outcome.actionCodeDescription,
        ErrorMessage: outcome.errorMessage,
    };
    delete failed.OrderStatus;
    if (outcome.respCode) failed.params = { respCode: outcome.respCode, respCode_desc: outcome.respCodeDesc };
    return failed;
}

function handleConfirm(form, res) {
    const order = orders.get(form.mdOrder);
    if (!order) return sendJson(res, capitalised(UNKNOWN_ORDER));
    if (order.outcome && (order.outcome.orderStatus === "2" || order.orderStatus === "1")) {
        order.orderStatus = "2";
        order.depositAmountMinor = order.amountMinor;
    }
    log(`confirm: ${order.orderId} -> OrderStatus ${order.outcome ? order.orderStatus : "0"}`);
    return sendJson(res, orderPayload(order));
}

function handleStatus(form, res) {
    const order = orders.get(form.orderId);
    if (!order) return sendJson(res, capitalised(UNKNOWN_ORDER));
    return sendJson(res, orderPayload(order));
}

function handleRefund(form, res) {
    const order = orders.get(form.orderId);
    if (!order) return sendJson(res, capitalised(UNKNOWN_ORDER));
    if (order.orderStatus !== "2") {
        return sendJson(res, { ErrorCode: wire(7), ErrorMessage: "Order is not in a refundable state" });
    }
    order.orderStatus = "4";
    order.depositAmountMinor = Math.max(0, order.depositAmountMinor - Number(form.amount ?? 0));
    log(`refund: ${order.orderId}`);
    return sendJson(res, orderPayload(order));
}

function handleReverse(form, res) {
    const order = orders.get(form.orderId);
    if (!order) return sendJson(res, capitalised(UNKNOWN_ORDER));
    order.orderStatus = "3";
    order.depositAmountMinor = 0;
    log(`reverse: ${order.orderId}`);
    return sendJson(res, orderPayload(order));
}

// ── Hosted payment pages ─────────────────────────────────────────────

const T = {
    FR: {
        title: "Paiement sécurisé", pay: "Payer", cancel: "Annuler le paiement",
        number: "Numéro de carte", expiry: "Expiration (MM/AA)", cvv: "Cryptogramme (CVV)",
        holder: "Nom du porteur", order: "Commande", amount: "Montant",
        otpTitle: "Authentification 3-D Secure", otpLabel: "Code reçu par SMS",
        otpHelp: "Un code à 6 chiffres a été envoyé au numéro associé à votre carte.",
        submit: "Valider", retry: "Réessayer avec une autre carte", back: "Retour à la boutique",
        declined: "Paiement refusé", expired: "Session expirée",
    },
    EN: {
        title: "Secure payment", pay: "Pay", cancel: "Cancel payment",
        number: "Card number", expiry: "Expiry (MM/YY)", cvv: "Security code (CVV)",
        holder: "Cardholder name", order: "Order", amount: "Amount",
        otpTitle: "3-D Secure authentication", otpLabel: "Code sent by SMS",
        otpHelp: "A 6-digit code has been sent to the number linked to your card.",
        submit: "Submit", retry: "Try another card", back: "Back to the shop",
        declined: "Payment declined", expired: "Session expired",
    },
};
const t = (order) => T[order.language] ?? T.FR;

const SHELL = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
 body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#eef1f5;
      margin:0;padding:40px 16px;color:#16202b}
 .card{max-width:440px;margin:0 auto;background:#fff;border-radius:14px;
       box-shadow:0 1px 3px rgba(16,32,48,.12),0 8px 24px rgba(16,32,48,.08);overflow:hidden}
 .head{background:#0d2a4a;color:#fff;padding:18px 24px;display:flex;align-items:center;gap:10px}
 .head strong{font-size:16px;font-weight:600} .head .sec{margin-left:auto;font-size:12px;opacity:.8}
 .body{padding:24px}
 .amt{font-size:30px;font-weight:650;letter-spacing:-.02em} .ord{color:#63748a;font-size:13px;margin-bottom:20px}
 label{display:block;font-size:12px;font-weight:600;color:#41546b;margin:14px 0 5px;letter-spacing:.02em}
 input{width:100%;padding:11px 12px;border:1px solid #ccd6e0;border-radius:8px;font:16px ui-monospace,monospace;
       letter-spacing:.06em;background:#fbfcfd}
 input:focus{outline:0;border-color:#0d6efd;box-shadow:0 0 0 3px rgba(13,110,253,.12)}
 .split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
 button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:8px;background:#0f6f4c;color:#fff;
        font:600 16px system-ui;cursor:pointer} button:hover{background:#0b5b3e}
 .link{display:block;text-align:center;margin-top:14px;color:#41546b;font-size:14px}
 .err{background:#fdecea;border:1px solid #f5c6c2;color:#a3221a;padding:10px 12px;border-radius:8px;
      font-size:14px;margin-bottom:6px}
 .note{margin-top:22px;padding-top:16px;border-top:1px solid #e6ebf0;font-size:12px;color:#7a8ba0}
 .note code{background:#f2f5f8;padding:1px 5px;border-radius:4px;font-size:11px}
 .note table{width:100%;border-collapse:collapse;margin-top:6px} .note td{padding:2px 0;vertical-align:top}
 .brand{font-size:12px;color:#63748a;margin-top:6px;min-height:16px}
</style></head><body>${body}</body></html>`;

function paymentPage(order, error) {
    const L = t(order);
    const cards = Object.entries(TEST_CARDS)
        .map(([pan, c]) => `<tr><td><code>${pan}</code></td><td>${c.label}</td></tr>`).join("");
    return SHELL(L.title, `<div class="card">
  <div class="head"><strong>SATIM</strong><span class="sec">🔒 ${L.title}</span></div>
  <div class="body">
    <div class="amt">${(order.amountMinor / 100).toFixed(2)} ${order.currency === "012" ? "DZD" : order.currency}</div>
    <div class="ord">${L.order} ${order.orderNumber}${order.description ? ` — ${order.description}` : ""}</div>
    ${error ? `<div class="err">${error}</div>` : ""}
    <form method="POST" action="/payment/rest/__pay" autocomplete="off">
      <input type="hidden" name="mdOrder" value="${order.orderId}">
      <label>${L.number}</label>
      <input name="pan" inputmode="numeric" maxlength="19" placeholder="6280 5810 0000 0009" required
             oninput="this.value=this.value.replace(/\\D/g,'').slice(0,19);
                      document.getElementById('b').textContent=
                        this.value.startsWith('628058')?'CIB':this.value.startsWith('507800')?'Edahabia':''">
      <div class="brand" id="b"></div>
      <div class="split">
        <div><label>${L.expiry}</label>
          <input name="expiry" maxlength="5" placeholder="12/28" required
                 oninput="this.value=this.value.replace(/[^0-9/]/g,'').replace(/^(\\d{2})(\\d)/,'$1/$2').slice(0,5)"></div>
        <div><label>${L.cvv}</label>
          <input name="cvv" inputmode="numeric" maxlength="4" placeholder="123" required
                 oninput="this.value=this.value.replace(/\\D/g,'')"></div>
      </div>
      <label>${L.holder}</label>
      <input name="holder" maxlength="26" placeholder="AHMED BENALI" required
             style="letter-spacing:.04em;text-transform:uppercase">
      <button type="submit">${L.pay} ${(order.amountMinor / 100).toFixed(2)} DZD</button>
    </form>
    <form method="POST" action="/payment/rest/__cancel">
      <input type="hidden" name="mdOrder" value="${order.orderId}">
      <button type="submit" class="link" style="background:none;color:#63748a;padding:0;margin-top:12px;
              font-weight:400;font-size:14px">${L.cancel}</button>
    </form>
    <div class="note"><strong>Test cards</strong> — any future expiry, any CVV, OTP <code>${VALID_OTP}</code>
      <table>${cards}</table>
    </div>
  </div></div>`);
}

function otpPage(order, error) {
    const L = t(order);
    return SHELL(L.otpTitle, `<div class="card">
  <div class="head"><strong>3-D Secure</strong><span class="sec">🔒 ${order.current.brand}</span></div>
  <div class="body">
    <div class="amt">${(order.amountMinor / 100).toFixed(2)} DZD</div>
    <div class="ord">${L.order} ${order.orderNumber} — ${order.current.pan.slice(0, 6)}****${order.current.pan.slice(-4)}</div>
    ${error ? `<div class="err">${error}</div>` : ""}
    <p style="color:#41546b;font-size:14px">${L.otpHelp}</p>
    <form method="POST" action="/payment/rest/__3ds">
      <input type="hidden" name="mdOrder" value="${order.orderId}">
      <label>${L.otpLabel}</label>
      <input name="otp" inputmode="numeric" maxlength="6" placeholder="••••••" required autofocus
             oninput="this.value=this.value.replace(/\\D/g,'')">
      <button type="submit">${L.submit}</button>
    </form>
    <div class="note">Test OTP: <code>${VALID_OTP}</code>. Anything else is refused
      (${MAX_OTP_ATTEMPTS} attempts).</div>
  </div></div>`);
}

function declinedPage(order) {
    const L = t(order);
    const reason = order.outcome?.actionCodeDescription ?? L.declined;
    const back = order.outcome === EXPIRED ? order.failUrl : null;
    return SHELL(L.declined, `<div class="card">
  <div class="head"><strong>SATIM</strong><span class="sec">${L.declined}</span></div>
  <div class="body">
    <div class="err">${reason}</div>
    <div class="ord" style="margin-top:14px">${L.order} ${order.orderNumber}</div>
    ${back ? "" : `<a class="link" href="/payment/merchants/mockshop/payment.html?mdOrder=${order.orderId}"
       style="display:block;margin-top:18px;padding:12px;background:#0f6f4c;color:#fff;border-radius:8px;
              text-decoration:none;font-weight:600">${L.retry}</a>`}
    <a class="link" href="${order.failUrl}${order.failUrl.includes("?") ? "&" : "?"}orderId=${order.orderId}"
       style="margin-top:12px">${L.back}</a>
    <div class="note">A real gateway lets the cardholder retry a declined order.
      That second attempt is where integrations break.</div>
  </div></div>`);
}

// ── Payment flow ─────────────────────────────────────────────────────

/** Fire the merchant's server-to-server callback, as the gateway does. */
async function notify(order, why) {
    if (!order.dynamicCallbackUrl) return;
    const target = `${order.dynamicCallbackUrl}${order.dynamicCallbackUrl.includes("?") ? "&" : "?"}orderId=${order.orderId}`;
    try {
        const response = await fetch(target, { method: "POST" });
        log(`callback (${why}) -> ${target} (HTTP ${response.status})`);
    } catch (err) {
        log(`callback (${why}) failed: ${err.message}`);
    }
}

/** Apply an issuer outcome to the order and notify the merchant. */
async function settle(order, outcome, why) {
    order.outcome = outcome;
    if (outcome.orderStatus !== null) order.orderStatus = outcome.orderStatus;
    order.attempts.push({ at: Date.now(), pan: order.current?.pan, outcome: outcome.actionCodeDescription });
    if (order.current) {
        order.card = { ...order.current, approvalCode: outcome.orderStatus ? randomApproval() : undefined };
        order.current = null;
    }
    await notify(order, why);
}

const randomApproval = () => String(Math.floor(100000 + Math.random() * 899999));

/** Validate the card form the way a hosted page does. */
function validateCard(form) {
    const pan = String(form.pan ?? "").replace(/\s/g, "");
    if (!luhnValid(pan)) return "Numéro de carte invalide.";
    if (!brandOf(pan)) return "Type de carte non accepté (CIB ou Edahabia uniquement).";

    const m = /^(\d{2})\/(\d{2})$/.exec(String(form.expiry ?? "").trim());
    if (!m) return "Date d'expiration invalide (MM/AA).";
    const month = Number(m[1]);
    const year = 2000 + Number(m[2]);
    if (month < 1 || month > 12) return "Mois d'expiration invalide.";
    const endOfMonth = new Date(year, month, 1).getTime();
    if (endOfMonth < Date.now()) return "Carte expirée.";

    if (!/^\d{3,4}$/.test(String(form.cvv ?? ""))) return "Cryptogramme invalide.";
    if (!String(form.holder ?? "").trim()) return "Nom du porteur requis.";
    return null;
}

async function handlePay(form, res, req) {
    const order = orders.get(form.mdOrder);
    if (!order) return sendHtml(res, "<h1>Unknown order</h1>", 404);

    if (Date.now() > order.expiresAt) {
        log(`pay: ${order.orderId} session expired`);
        await settle(order, EXPIRED, "expired");
        return sendHtml(res, declinedPage(order));
    }

    const invalid = validateCard(form);
    if (invalid) {
        log(`pay: ${order.orderId} rejected at the form — ${invalid}`);
        return sendHtml(res, paymentPage(order, invalid));
    }

    const pan = String(form.pan).replace(/\s/g, "");
    const card = TEST_CARDS[pan] ?? UNKNOWN_CARD;
    order.current = {
        pan,
        brand: brandOf(pan),
        holder: String(form.holder).trim().toUpperCase(),
        expiration: `20${form.expiry.slice(3)}${form.expiry.slice(0, 2)}`,
        ip: req.socket.remoteAddress?.replace("::ffff:", "") ?? "127.0.0.1",
        otpAttempts: 0,
        card,
    };
    log(`pay: ${order.orderId} attempt ${order.attempts.length + 1} with ${pan} (${card.label})`);

    await sleep(LATENCY);

    if (card.threeDS === "none") {
        await settle(order, card.authorise, "authorised");
        return finishAttempt(order, res);
    }
    return sendHtml(res, otpPage(order));
}

async function handle3ds(form, res) {
    const order = orders.get(form.mdOrder);
    if (!order?.current) return sendHtml(res, "<h1>No authentication in progress</h1>", 400);

    const L = t(order);
    const attempt = order.current;
    attempt.otpAttempts++;
    const correct = String(form.otp ?? "") === VALID_OTP && attempt.card.threeDS === "pass";

    await sleep(LATENCY);

    if (correct) {
        log(`3ds: ${order.orderId} authenticated`);
        await settle(order, attempt.card.authorise, "authorised");
        return finishAttempt(order, res);
    }

    if (attempt.otpAttempts >= MAX_OTP_ATTEMPTS) {
        log(`3ds: ${order.orderId} failed after ${attempt.otpAttempts} attempts`);
        await settle(order, {
            orderStatus: null, actionCode: "111",
            actionCodeDescription: "Authentification du porteur échouée",
            respCode: "117", respCodeDesc: "Code confidentiel erroné",
            errorMessage: "Payment is declined",
        }, "3ds-failed");
        return sendHtml(res, declinedPage(order));
    }

    const left = MAX_OTP_ATTEMPTS - attempt.otpAttempts;
    return sendHtml(res, otpPage(order, `Code incorrect. ${left} tentative(s) restante(s).`));
}

async function handleCancel(form, res) {
    const order = orders.get(form.mdOrder);
    if (!order) return sendHtml(res, "<h1>Unknown order</h1>", 404);
    log(`cancel: ${order.orderId}`);
    await settle(order, CANCELLED, "cancelled");
    return redirect(res, `${order.failUrl}${order.failUrl.includes("?") ? "&" : "?"}orderId=${order.orderId}`);
}

/** Send the browser onward, or offer a retry when the issuer said no. */
function finishAttempt(order, res) {
    const approved = order.outcome.orderStatus !== null;
    if (!approved) return sendHtml(res, declinedPage(order));
    const back = order.returnUrl;
    return redirect(res, `${back}${back.includes("?") ? "&" : "?"}orderId=${order.orderId}`);
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

    if (path === "/__control" && req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        armedFaults = (JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").faults ?? [])
            .filter((f) => f in FAULTS);
        log(`armed faults: ${armedFaults.join(", ") || "(none)"}`);
        return sendJson(res, { armed: armedFaults });
    }
    if (path === "/__reset" && req.method === "POST") {
        orders.clear(); byRequestId.clear(); byOrderNumber.clear(); armedFaults = [];
        return sendJson(res, { ok: true });
    }
    if (path === "/__expire" && req.method === "POST") {
        const order = orders.get(url.searchParams.get("orderId"));
        if (order) order.expiresAt = Date.now() - 1;
        return sendJson(res, { ok: Boolean(order) });
    }
    if (path === "/__notify" && req.method === "POST") {
        const order = orders.get(url.searchParams.get("orderId"));
        if (!order) return sendJson(res, { sent: false });
        await notify(order, "replay");
        return sendJson(res, { sent: true });
    }
    if (path === "/__orders") {
        return sendJson(res, [...orders.values()].map((o) => ({
            orderId: o.orderId, orderNumber: o.orderNumber, amountMinor: o.amountMinor,
            orderStatus: o.orderStatus, attempts: o.attempts,
        })));
    }

    if (path.startsWith("/payment/merchants/") && req.method === "GET") {
        const order = orders.get(url.searchParams.get("mdOrder"));
        if (!order) return sendHtml(res, "<h1>Unknown order</h1>", 404);
        return sendHtml(res, paymentPage(order));
    }
    if (path === "/payment/rest/__pay" && req.method === "POST") return handlePay(await readForm(req), res, req);
    if (path === "/payment/rest/__3ds" && req.method === "POST") return handle3ds(await readForm(req), res);
    if (path === "/payment/rest/__cancel" && req.method === "POST") return handleCancel(await readForm(req), res);

    const handler = REST[path];
    if (!handler || req.method !== "POST") {
        return sendJson(res, { errorCode: wire(404), errorMessage: "Not found" }, 404);
    }
    if (applyFault(res)) return;

    const form = await readForm(req);
    if (!authOk(form)) {
        log(`auth rejected for userName=${form.userName ?? "(none)"}`);
        return sendJson(res, path.includes("register")
            ? { ...ACCESS_DENIED, errorCode: wire(ACCESS_DENIED.errorCode) }
            : capitalised(ACCESS_DENIED));
    }
    return handler(form, res);
});

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(`[mock] port ${PORT} is already in use — another gateway is probably running.`);
        console.error(`[mock] stop it, or start this one on another port: PORT=8888 node mock/gateway.mjs`);
        process.exit(1);
    }
    throw err;
});

server.listen(PORT, HOST, () => {
    console.log(`[mock] SATIM gateway on http://localhost:${PORT}  (wire: ${WIRE_STYLE}, latency: ${LATENCY}ms)`);
    console.log(`[mock] credentials: userName=${CREDENTIALS.userName} password=${CREDENTIALS.password}`);
});

export { server };

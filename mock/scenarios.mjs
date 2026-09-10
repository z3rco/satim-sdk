/**
 * Test cards, issuer behaviour and fault definitions for the mock gateway.
 *
 * Every PAN here is Luhn-valid, so the hosted form's validation accepts it
 * the way it would accept a real card. What separates them is what the
 * *issuer* does once the card is accepted: authorise, decline with a
 * specific response code, fail the 3-D Secure challenge, or never answer.
 *
 * None of these are real cards. They sit in CIB-style (`628058`) and
 * Edahabia-style (`507800`) ranges so they look plausible in logs and are
 * routed by BIN the way the real thing routes.
 */

/** Verify a PAN the way the payment form does. */
export function luhnValid(pan) {
    if (!/^\d{13,19}$/.test(pan)) return false;
    let sum = 0;
    let double = false;
    for (let i = pan.length - 1; i >= 0; i--) {
        let digit = Number(pan[i]);
        if (double) { digit *= 2; if (digit > 9) digit -= 9; }
        sum += digit;
        double = !double;
    }
    return sum % 10 === 0;
}

/** Card brand from the BIN, as the gateway would route it. */
export function brandOf(pan) {
    if (pan.startsWith("628058")) return "CIB";
    if (pan.startsWith("507800")) return "Edahabia";
    return null;
}

/**
 * Issuer outcomes keyed by PAN.
 *
 * `threeDS` decides what the challenge step does:
 * - `"pass"`   — the correct OTP authenticates.
 * - `"fail"`   — every OTP is refused, however many times you try.
 * - `"none"`   — the issuer does not challenge (frictionless).
 *
 * `authorise` runs only once authentication succeeded. `orderStatus: null`
 * means the gateway reports no `OrderStatus` at all, which is what a real
 * decline looks like on the wire.
 *
 * A card carrying `balanceMinor` is checked against the order amount and
 * debited on approval, falling back to its `insufficient` outcome when the
 * account is short. Refunds credit it back.
 */
export const TEST_CARDS = {
    "6280581000000007": {
        label: "CIB — approved",
        threeDS: "pass",
        authorise: {
            orderStatus: "2",
            actionCode: "0",
            actionCodeDescription: "Votre paiement a été accepté",
            respCode: "00",
            respCodeDesc: "Paiement accepté",
        },
    },
    "6280581000000015": {
        label: "CIB — insufficient funds",
        threeDS: "pass",
        authorise: {
            orderStatus: null,
            actionCode: "2003",
            actionCodeDescription: "Provision insuffisante",
            respCode: "116",
            respCodeDesc: "Provision insuffisante",
            errorMessage: "Payment is declined",
        },
    },
    "6280581000000023": {
        label: "CIB — 3-D Secure authentication always fails",
        threeDS: "fail",
        authorise: {
            orderStatus: null,
            actionCode: "111",
            actionCodeDescription: "Authentification du porteur échouée",
            respCode: "117",
            respCodeDesc: "Code confidentiel erroné",
            errorMessage: "Payment is declined",
        },
    },
    "6280581000000031": {
        label: "CIB — do not honour",
        threeDS: "pass",
        authorise: {
            orderStatus: null,
            actionCode: "2003",
            actionCodeDescription: "Transaction refusée par l'émetteur",
            respCode: "05",
            respCodeDesc: "Ne pas honorer",
            errorMessage: "Payment is declined",
        },
    },
    "6280581000000049": {
        label: "CIB — restricted card",
        threeDS: "pass",
        authorise: {
            orderStatus: null,
            actionCode: "2003",
            actionCodeDescription: "Carte restreinte",
            respCode: "62",
            respCodeDesc: "Carte restreinte",
            errorMessage: "Payment is declined",
        },
    },
    "6280581000000056": {
        label: "CIB — pre-authorization approved (funds held)",
        threeDS: "pass",
        authorise: {
            orderStatus: "1",
            actionCode: "0",
            actionCodeDescription: "Autorisation accordée",
            respCode: "00",
            respCodeDesc: "Autorisation accordée",
        },
    },
    "6280581000000064": {
        label: "CIB — issuer unavailable (order stays pending)",
        threeDS: "pass",
        authorise: {
            orderStatus: "0",
            actionCode: "1",
            actionCodeDescription: "Émetteur indisponible, réessayez",
            respCode: "91",
            respCodeDesc: "Émetteur indisponible",
        },
    },
    "6280581000000072": {
        label: "CIB — funded account, 10 000,00 DA balance",
        threeDS: "pass",
        // A real balance the issuer checks against the amount, and debits on
        // approval. Whether this card is approved or declined depends on what
        // is left, not on a script — so the decline is earned, and draining it
        // across several orders is a state no scripted card can reach.
        balanceMinor: 1_000_000,
        authorise: {
            orderStatus: "2",
            actionCode: "0",
            actionCodeDescription: "Votre paiement a été accepté",
            respCode: "00",
            respCodeDesc: "Paiement accepté",
        },
        insufficient: {
            orderStatus: null,
            actionCode: "2003",
            actionCodeDescription: "Provision insuffisante",
            respCode: "116",
            respCodeDesc: "Provision insuffisante",
            errorMessage: "Payment is declined",
        },
    },
    "5078001000000004": {
        label: "Edahabia — approved",
        threeDS: "none",
        authorise: {
            orderStatus: "2",
            actionCode: "0",
            actionCodeDescription: "Votre paiement a été accepté",
            respCode: "00",
            respCodeDesc: "Paiement accepté",
        },
    },
};

/** The OTP the 3-D Secure step accepts. Anything else is refused. */
export const VALID_OTP = "123456";
/** Refused OTP attempts before the attempt is abandoned as a failure. */
export const MAX_OTP_ATTEMPTS = 3;

/** Outcome for a card the gateway does not recognise at all. */
export const UNKNOWN_CARD = {
    label: "unknown card",
    threeDS: "none",
    authorise: {
        orderStatus: null,
        actionCode: "2003",
        actionCodeDescription: "Carte non reconnue",
        respCode: "14",
        respCodeDesc: "Numéro de porteur invalide",
        errorMessage: "Payment is declined",
    },
};

/** Cardholder cancelled on the payment page. */
export const CANCELLED = {
    orderStatus: null,
    actionCode: "10",
    actionCodeDescription: "Paiement annulé par le porteur",
    errorMessage: "Payment is cancelled",
};

/** Payment session ran past `sessionTimeoutSecs`. */
export const EXPIRED = {
    orderStatus: null,
    actionCode: "-2007",
    actionCodeDescription: "Session expirée",
    errorMessage: "Session timed out",
};

/**
 * Transport-level faults, armed through `POST /__control`.
 *
 * These reach the paths a healthy gateway never produces — which is
 * exactly where the circuit-breaker accounting bugs were hiding.
 */
export const FAULTS = {
    http503: { status: 503, body: "Service Unavailable", contentType: "text/plain" },
    http500: { status: 500, body: "Internal Server Error", contentType: "text/plain" },
    http400: { status: 400, body: "Bad Request", contentType: "text/plain" },
    html200: { status: 200, body: "<html><body>502 Bad Gateway</body></html>", contentType: "text/html" },
    malformed: { status: 200, body: "{not json at all", contentType: "application/json" },
    nonObject: { status: 200, body: '"just a string"', contentType: "application/json" },
    hang: { hangMs: 60_000 },
};

/** Duplicate-order rejection, mirroring the real `errorCode: 1`. */
export const DUPLICATE_ORDER = { errorCode: 1, errorMessage: "Duplicate order number" };

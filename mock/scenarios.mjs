/**
 * Test cards and fault definitions for the mock SATIM gateway.
 *
 * The real gateway hands certified merchants a sheet of test PANs that
 * drive specific outcomes. These are the same idea with invented numbers:
 * the PAN chosen on the mock payment page decides how the order resolves.
 *
 * None of these are real card numbers. The 628058 prefix mimics the CIB
 * BIN range purely so the values look plausible in logs.
 */

/**
 * Outcomes a payment attempt can produce.
 *
 * `orderStatus` follows the SATIM/BPC state machine (`"2"` deposited,
 * `"0"` still registered). A `null` means the gateway reports no
 * `OrderStatus` at all — which is what a decline, a cancellation and an
 * expiry actually look like on the wire, and the reason the SDK cannot
 * treat "no OrderStatus" as a terminal state.
 */
export const TEST_CARDS = {
    "6280581000000000": {
        label: "Approved",
        orderStatus: "2",
        actionCode: "0",
        actionCodeDescription: "Votre paiement a été accepté",
        respCode: "00",
        respCodeDesc: "Paiement accepté",
        approvalCode: "A12345",
    },
    "6280581000000001": {
        label: "Declined by issuer (insufficient funds)",
        orderStatus: null,
        actionCode: "2003",
        actionCodeDescription: "Votre transaction a été rejetée",
        respCode: "116",
        respCodeDesc: "Provision insuffisante",
        errorMessage: "Payment is declined",
    },
    "6280581000000002": {
        label: "Declined — 3-D Secure authentication failed",
        orderStatus: null,
        actionCode: "111",
        actionCodeDescription: "Authentification 3-D Secure échouée",
        respCode: "117",
        respCodeDesc: "Code confidentiel erroné",
        errorMessage: "Payment is declined",
    },
    "6280581000000003": {
        label: "Session expired before completion",
        orderStatus: null,
        actionCode: "-2007",
        actionCodeDescription: "Session expirée",
        errorMessage: "Session timed out",
    },
    "6280581000000004": {
        label: "Cancelled by cardholder",
        orderStatus: null,
        actionCode: "10",
        actionCodeDescription: "Paiement annulé par le porteur",
        errorMessage: "Payment is cancelled",
    },
    "6280581000000005": {
        label: "Pre-authorized (funds held, awaiting capture)",
        orderStatus: "1",
        actionCode: "0",
        actionCodeDescription: "Autorisation accordée",
        respCode: "00",
        respCodeDesc: "Autorisation accordée",
        approvalCode: "A54321",
    },
};

/** Cardholder PII the gateway attaches to a completed attempt. */
export const CARDHOLDER = {
    Ip: "41.100.12.34",
    cardholderName: "TEST CARDHOLDER",
    expiration: "202812",
};

/**
 * Transport-level faults, armed through `POST /__control`.
 *
 * These exist to exercise the SDK's retry loop, circuit breaker and
 * response-shape validation — paths that a well-behaved gateway never
 * reaches, and which are exactly where the accounting bugs hid.
 */
export const FAULTS = {
    /** Respond 503 so the SDK sees a retryable server error. */
    http503: { status: 503, body: "Service Unavailable", contentType: "text/plain" },
    /** Respond 500. */
    http500: { status: 500, body: "Internal Server Error", contentType: "text/plain" },
    /** A 4xx, which must NOT count toward opening the breaker. */
    http400: { status: 400, body: "Bad Request", contentType: "text/plain" },
    /** HTTP 200 carrying an HTML error page — a degraded proxy in front of a dead gateway. */
    html200: { status: 200, body: "<html><body>502 Bad Gateway</body></html>", contentType: "text/html" },
    /** Valid HTTP, invalid JSON. */
    malformed: { status: 200, body: "{not json at all", contentType: "application/json" },
    /** A JSON primitive rather than an object. */
    nonObject: { status: 200, body: '"just a string"', contentType: "application/json" },
    /** Hang past any sane client timeout so the SDK aborts. */
    hang: { hangMs: 60_000 },
};

/** Duplicate-order rejection, mirroring the real `errorCode: 1`. */
export const DUPLICATE_ORDER = { errorCode: 1, errorMessage: "Duplicate order number" };

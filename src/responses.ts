import { SatimMissingDataError, SatimInvalidArgumentError, SatimUnexpectedResponseError } from "./exceptions";
import type { RegisterOrderResponse, ConfirmOrderResponse } from "./types";
import { toMinorUnits, isWholeMinorUnits } from "./utils";

/** Trusted SATIM gateway hostnames for redirect validation. */
const TRUSTED_SATIM_HOSTNAMES = new Set([
    "satim.dz",
    "cib.satim.dz",
    "test.satim.dz",
    "test2.satim.dz",
]);

/**
 * Validate that a registration response has the expected shape.
 * Catches malformed, missing, or unexpected gateway responses at the SDK boundary.
 */
function validateRegisterSchema(raw: unknown): asserts raw is RegisterOrderResponse {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new SatimUnexpectedResponseError("Malformed registration response: not an object", "gateway");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.orderId !== "string" || !r.orderId) {
        throw new SatimUnexpectedResponseError("Malformed registration response: missing or invalid orderId", "gateway");
    }
    if (typeof r.formUrl !== "string" || !r.formUrl) {
        throw new SatimUnexpectedResponseError("Malformed registration response: missing or invalid formUrl", "gateway");
    }
    if (r.errorCode !== undefined && typeof r.errorCode !== "string") {
        throw new SatimUnexpectedResponseError("Malformed registration response: errorCode must be a string", "gateway");
    }
}

/**
 * Validate that an order management response has the expected shape.
 * Catches malformed, missing, or unexpected gateway responses at the SDK boundary.
 */
function validateConfirmSchema(raw: unknown): asserts raw is ConfirmOrderResponse {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new SatimUnexpectedResponseError("Malformed order response: not an object", "gateway");
    }
    const r = raw as Record<string, unknown>;

    // SATIM spec example sends OrderStatus as a number (e.g. 2).
    // Normalise to string so all predicate comparisons (=== "2") work correctly
    // regardless of whether the gateway serialises it as number or string.
    if (r.OrderStatus !== undefined) {
        if (typeof r.OrderStatus === "number") {
            r.OrderStatus = String(r.OrderStatus);
        } else if (typeof r.OrderStatus !== "string") {
            throw new SatimUnexpectedResponseError("Malformed order response: OrderStatus must be a string or number", "gateway");
        }
    }

    // Same normalisation for ErrorCode — spec shows "0" but some responses send 0
    if (r.ErrorCode !== undefined) {
        if (typeof r.ErrorCode === "number") {
            r.ErrorCode = String(r.ErrorCode);
        } else if (typeof r.ErrorCode !== "string") {
            throw new SatimUnexpectedResponseError("Malformed order response: ErrorCode must be a string or number", "gateway");
        }
    }

    if (r.actionCode !== undefined && typeof r.actionCode !== "string" && typeof r.actionCode !== "number") {
        throw new SatimUnexpectedResponseError("Malformed order response: actionCode must be a string or number", "gateway");
    }
    if (r.actionCode !== undefined && typeof r.actionCode === "number") {
        r.actionCode = String(r.actionCode);
    }
}

export class RegisterResponse {
    private readonly _raw: RegisterOrderResponse;

    constructor(raw: RegisterOrderResponse) {
        validateRegisterSchema(raw);
        this._raw = structuredClone(raw);
    }

    /** Extract the order ID from the registration response. */
    public getOrderId(): string {
        return this._raw.orderId;
    }

    /**
     * Extract the hosted payment form URL from the registration response.
     * @throws SatimMissingDataError if no formUrl is present.
     */
    public getUrl(): string {
        if (!this._raw.formUrl) {
            throw new SatimMissingDataError("No payment form URL found.");
        }
        return this._raw.formUrl;
    }

    /**
     * Build a standard Web API `Response` that performs a 302 redirect
     * to the hosted payment form.
     *
     * @throws SatimInvalidArgumentError if the formUrl does not point to a trusted SATIM domain.
     */
    public redirectResponse(): Response {
        const url = this.getUrl();
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:") {
                throw new SatimInvalidArgumentError(
                    "Payment form URL must use HTTPS.",
                );
            }
            const hostname = parsed.hostname.toLowerCase();
            if (!TRUSTED_SATIM_HOSTNAMES.has(hostname)) {
                throw new SatimInvalidArgumentError(
                    `Untrusted payment form URL origin: ${hostname}. Expected a known satim.dz hostname.`,
                );
            }
        } catch (err) {
            if (err instanceof SatimInvalidArgumentError) throw err;
            throw new SatimInvalidArgumentError("Invalid payment form URL received from gateway.");
        }
        return Response.redirect(url, 302);
    }

    /**
     * Returns a sanitized copy of the raw gateway response.
     * Use this for debugging; prefer typed accessor methods for business logic.
     */
    public getRawResponse(): RegisterOrderResponse {
        return structuredClone(this._raw);
    }
}

export class ConfirmResponse {
    private readonly _raw: ConfirmOrderResponse;

    constructor(raw: ConfirmOrderResponse) {
        const cloned = structuredClone(raw);
        validateConfirmSchema(cloned);
        this._raw = cloned;
    }

    /** IP address of the cardholder, if available. */
    public getIpAddress(): string | undefined {
        return this._raw.Ip;
    }

    /** Cardholder name as returned by the issuer, if available. */
    public getCardHolderName(): string | undefined {
        return this._raw.cardholderName;
    }

    /** Card expiration date (YYYYMM), if available. */
    public getCardExpiry(): string | undefined {
        return this._raw.expiration;
    }

    /** Masked card PAN, if available. */
    public getCardPan(): string | undefined {
        return this._raw.Pan;
    }

    /** Issuer approval code, if available. */
    public getApprovalCode(): string | undefined {
        return this._raw.approvalCode;
    }

    /**
     * The confirmed payment amount in major units.
     * The gateway returns this in minor units (centimes/cents), so we divide by 100.
     * Uses toFixed(2) to avoid IEEE 754 representation artifacts.
     * Returns undefined if the amount is absent, non-satim-module, or not a whole
     * number of minor units (fractional centimes are rejected as invalid).
     */
    public getAmount(): number | undefined {
        const rawAmount = this._raw.Amount ?? this._raw.amount;
        if (rawAmount === undefined) return undefined;
        const str = String(rawAmount).trim();
        if (!/^\d+$/.test(str)) return undefined;
        const parsed = Number(str);
        if (!isWholeMinorUnits(parsed)) return undefined;
        if (parsed > Number.MAX_SAFE_INTEGER) return undefined;
        return parseFloat((parsed / 100).toFixed(2));
    }

    /**
     * The actual debited (deposited) amount in major units.
     *
     * Per the SATIM spec, `depositAmount` is the amount actually charged to the
     * customer's card. For standard payments it equals `getAmount()`. For
     * pre-authorization flows it may be less than the original hold amount.
     *
     * Returns undefined if the field is absent or non-satim-module.
     */
    public getDepositAmount(): number | undefined {
        const raw = this._raw.depositAmount;
        if (raw === undefined) return undefined;
        const str = String(raw).trim();
        if (!/^\d+$/.test(str)) return undefined;
        const parsed = Number(str);
        if (!isWholeMinorUnits(parsed)) return undefined;
        if (parsed > Number.MAX_SAFE_INTEGER) return undefined;
        return parseFloat((parsed / 100).toFixed(2));
    }

    /**
     * The confirmed order number as returned by the gateway.
     */
    public getOrderNumber(): string | undefined {
        return this._raw.OrderNumber ?? this._raw.orderNumber;
    }

    // ─── Status predicates ──────────────────────────────────────────────
    //
    // MUTUAL EXCLUSIVITY CONTRACT:
    //
    // For any gateway response, exactly ONE of the following groups is true:
    //
    //   1. isSuccessful    (OrderStatus "2")
    //   2. isPending       (OrderStatus "0")
    //   3. isReversed      (OrderStatus "3")
    //   4. isRefunded      (OrderStatus "4")
    //   5. isPreAuthorized (OrderStatus "1")
    //   6. isExpired       (actionCode "-2007", excludes groups 1-5)
    //   7. isCancelled     (actionCode "10" or message match, excludes groups 1-6)
    //   8. isRejected      (bank decline signals, excludes groups 1-7)
    //   9. isFailed        (catch-all: true only when ALL of 1-8 are false)
    //
    // The dependency chain is acyclic:
    //   isSuccessful, isPending, isReversed, isRefunded, isPreAuthorized → leaf
    //   isExpired    → calls 1-5
    //   isCancelled  → calls 1-5, 6
    //   isRejected   → calls 1-5, 6, 7
    //   isFailed     → calls 1-8
    //
    // No predicate calls isFailed, so no cycle is possible.
    // ────────────────────────────────────────────────────────────────────

    /** True if the order was successfully deposited (OrderStatus 2). */
    public isSuccessful(): boolean {
        return this._raw.OrderStatus === "2";
    }

    /** True if the order has been refunded (OrderStatus 4). */
    public isRefunded(): boolean {
        return this._raw.OrderStatus === "4";
    }

    /** True if the order is registered but not yet paid (OrderStatus 0). */
    public isPending(): boolean {
        return this._raw.OrderStatus === "0";
    }

    /** True if the authorization was reversed/voided (OrderStatus 3). */
    public isReversed(): boolean {
        return this._raw.OrderStatus === "3";
    }

    /**
     * True if the order is pre-authorized / funds held (OrderStatus 1).
     * BPC status "1" means the card has been charged but the merchant
     * has not yet captured (deposited) the funds.
     */
    public isPreAuthorized(): boolean {
        return this._raw.OrderStatus === "1";
    }

    /**
     * True if the payment session timed out (actionCode -2007).
     * Returns false for successful, refunded, pending, reversed, or pre-authorized
     * payments to ensure mutual exclusivity with other predicates.
     */
    public isExpired(): boolean {
        if (this.isSuccessful() || this.isRefunded() || this.isPending() || this.isReversed() || this.isPreAuthorized()) {
            return false;
        }
        return this._raw.actionCode === "-2007";
    }

    /**
     * True if the customer cancelled the payment (actionCode 10).
     * Returns false for successful, refunded, pending, reversed, pre-authorized,
     * or expired payments to ensure mutual exclusivity with other predicates.
     */
    public isCancelled(): boolean {
        if (this.isSuccessful() || this.isRefunded() || this.isPending() || this.isReversed() || this.isPreAuthorized() || this.isExpired()) {
            return false;
        }
        if ((this._raw.ErrorCode === "0" || this._raw.ErrorCode === undefined) && !this._raw.params && !this._raw.actionCode) {
            return false;
        }
        if (this._raw.actionCode === "10") {
            return true;
        }
        if (this._raw.ErrorMessage?.toLowerCase().includes("payment is cancelled")) {
            return true;
        }
        return false;
    }

    /**
     * True if the payment was explicitly declined by the bank.
     * Returns false for successful, refunded, pending, cancelled, reversed,
     * pre-authorized, or expired payments to ensure mutual exclusivity.
     */
    public isRejected(): boolean {
        if (this.isSuccessful() || this.isRefunded() || this.isPending() || this.isCancelled() || this.isReversed() || this.isPreAuthorized() || this.isExpired()) {
            return false;
        }
        if ((this._raw.ErrorCode === "0" || this._raw.ErrorCode === undefined) && !this._raw.params && !this._raw.actionCode) {
            return false;
        }
        if (this._raw.actionCode === "2003" || this._raw.actionCode === "111") {
            return true;
        }
        if (this._raw.params && typeof this._raw.params.respCode === "string" && this._raw.params.respCode !== "" && this._raw.params.respCode !== "00") {
            return true;
        }
        if (this._raw.ErrorMessage?.toLowerCase().includes("payment is declined")) {
            return true;
        }
        return false;
    }

    /**
     * True if the order is in a terminal failure state.
     *
     * This is the catch-all: it returns true ONLY when every other
     * predicate returns false. This guarantees that for any gateway
     * response, exactly one predicate group is active.
     *
     * Checks leaf predicates first (cheap OrderStatus comparisons),
     * then the composite predicates (which would re-check the same leaves).
     * Short-circuits on the first true predicate.
     *
     * Excludes: successful, pending, reversed, refunded, pre-authorized,
     *           expired, cancelled, AND rejected.
     */
    public isFailed(): boolean {
        // Check leaf predicates first — these are simple string comparisons
        // and cover OrderStatus values 0-4. If any match, we're done.
        if (this.isSuccessful() || this.isRefunded() || this.isPending()
            || this.isReversed() || this.isPreAuthorized()) {
            return false;
        }
        // Composite predicates (these internally re-check the leaves above,
        // but we already know they're all false so they'll skip quickly).
        if (this.isExpired() || this.isCancelled() || this.isRejected()) {
            return false;
        }
        return true;
    }

    /** Return a human-readable status message. */
    public getSuccessMessage(): string {
        if (this.isSuccessful()) {
            return (
                this._raw.params?.respCode_desc ??
                this._raw.actionCodeDescription ??
                "Payment was successful"
            );
        }
        if (this.isPending()) {
            return "Payment is pending";
        }
        if (this.isPreAuthorized()) {
            return "Payment is pre-authorized (awaiting capture)";
        }
        return this.getErrorMessage();
    }

    /** Return a human-readable error message extracted from the gateway response. */
    public getErrorMessage(): string {
        if (this.isExpired()) {
            return "Payment session expired";
        }
        if (this.isCancelled()) {
            return "Payment was cancelled";
        }
        if (this.isReversed()) {
            return "Payment authorization was voided";
        }
        if (this.isRejected()) {
            return "Your transaction was rejected";
        }
        if (this.isRefunded()) {
            return "Payment was refunded";
        }
        if (this.isPreAuthorized()) {
            return "Payment is pre-authorized (awaiting capture)";
        }
        return (
            this._raw.params?.respCode_desc ??
            this._raw.actionCodeDescription ??
            "Payment failed"
        );
    }

    /**
     * Ensures the captured amount matches the intended amount for the order.
     * Prevents partial payment vulnerabilities.
     *
     * Uses strict decimal parsing to reject hex/octal strings, and
     * IEEE 754-safe conversion via `toMinorUnits()` to avoid
     * floating-point rounding discrepancies.
     *
     * @param expectedAmount - The original amount requested in major units.
     * @throws Error if amounts do not match exactly.
     */
    public verifyAmount(expectedAmount: number): boolean {
        const rawAmount = this._raw.Amount ?? this._raw.amount;
        if (rawAmount === undefined) {
            throw new SatimUnexpectedResponseError("missing amount in payment response.", "gateway");
        }

        const str = String(rawAmount).trim();
        if (!/^\d+$/.test(str)) {
            throw new SatimUnexpectedResponseError("non-integer or non-positive amount in payment response.", "gateway");
        }

        const actualMinor = Number(str);
        if (!isWholeMinorUnits(actualMinor)) {
            throw new SatimUnexpectedResponseError("non-integer or non-positive amount in payment response.", "gateway");
        }

        const expectedMinor = toMinorUnits(expectedAmount);

        if (actualMinor !== expectedMinor) {
            throw new SatimUnexpectedResponseError(
                `payment amount mismatch. Expected ${expectedMinor} (minor units), got ${actualMinor}`,
                "gateway",
            );
        }
        return true;
    }

    /**
     * Returns a sanitized copy of the raw gateway response with
     * sensitive cardholder data redacted.
     * Use this for debugging; prefer typed accessor methods for business logic.
     */
    public getRawResponse(): Record<string, unknown> {
        const copy: Record<string, unknown> = structuredClone(this._raw);
        // Redact sensitive cardholder data
        if (copy.Ip !== undefined) copy.Ip = "[REDACTED]";
        if (copy.Pan !== undefined) copy.Pan = "[REDACTED]";
        if (copy.cardholderName !== undefined) copy.cardholderName = "[REDACTED]";
        if (copy.expiration !== undefined) copy.expiration = "[REDACTED]";
        return copy;
    }
}

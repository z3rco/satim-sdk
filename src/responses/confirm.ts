/**
 * ConfirmResponse: wraps /confirmOrder, /getOrderStatus, /refund, /reverse results.
 *
 * Status predicates are mutually exclusive. Exactly one terminal-state
 * predicate returns true for any given response. Dependency chain:
 *
 *   Leaves (OrderStatus comparisons): isSuccessful, isPending, isReversed,
 *                                     isRefunded, isPreAuthorized
 *   isExpired   → leaves
 *   isCancelled → leaves, isExpired
 *   isRejected  → leaves, isExpired, isCancelled
 *   isFailed    → catch-all (true only when all of the above are false)
 * @file
 */

import { SatimUnexpectedResponseError } from "../exceptions";
import type { ConfirmOrderResponse } from "../types";
import { toMinorUnits, isWholeMinorUnits } from "../money";
import { validateConfirmSchema } from "./schema";

/** Immutable wrapper around an order-management response with status predicates. */
export class ConfirmResponse {
    private readonly _raw: ConfirmOrderResponse;

    constructor(raw: ConfirmOrderResponse) {
        validateConfirmSchema(raw);
        this._raw = structuredClone(raw);
    }

    public getIpAddress(): string | undefined { return this._raw.Ip; }
    public getCardHolderName(): string | undefined { return this._raw.cardholderName; }
    public getCardExpiry(): string | undefined { return this._raw.expiration; }
    public getCardPan(): string | undefined { return this._raw.Pan; }
    public getApprovalCode(): string | undefined { return this._raw.approvalCode; }
    public getOrderNumber(): string | undefined {
        return this._raw.OrderNumber ?? this._raw.orderNumber;
    }

    /**
     * Captured amount in major units. Returns undefined when the gateway value is
     * absent, non-satim-module, fractional, or exceeds Number.MAX_SAFE_INTEGER.
     */
    public getAmount(): number | undefined {
        return parseMinorField(this._raw.Amount ?? this._raw.amount);
    }

    /** Actually-debited amount (may be less than getAmount() for partial captures). */
    public getDepositAmount(): number | undefined {
        return parseMinorField(this._raw.depositAmount);
    }

    // ─── Leaf predicates ─────────────────────────────────────────────────

    /** OrderStatus "2": deposited. */
    public isSuccessful(): boolean { return this._raw.OrderStatus === "2"; }
    /** OrderStatus "4": refunded. */
    public isRefunded(): boolean { return this._raw.OrderStatus === "4"; }
    /** OrderStatus "0": registered but not paid. */
    public isPending(): boolean { return this._raw.OrderStatus === "0"; }
    /** OrderStatus "3": authorization voided. */
    public isReversed(): boolean { return this._raw.OrderStatus === "3"; }
    /** OrderStatus "1": funds held, awaiting capture. */
    public isPreAuthorized(): boolean { return this._raw.OrderStatus === "1"; }

    // ─── Composite predicates ────────────────────────────────────────────

    /** Session timed out (actionCode -2007), excluding OrderStatus terminals. */
    public isExpired(): boolean {
        if (this.hasTerminalOrderStatus()) return false;
        return this._raw.actionCode === "-2007";
    }

    /** Customer cancelled (actionCode 10 or message match), excluding earlier states. */
    public isCancelled(): boolean {
        if (this.hasTerminalOrderStatus() || this.isExpired()) return false;
        if (!this.hasErrorSignal()) return false;
        if (this._raw.actionCode === "10") return true;
        return this._raw.ErrorMessage?.toLowerCase().includes("payment is cancelled") ?? false;
    }

    /** Bank declined (actionCode 2003/111 or non-"00" respCode), excluding earlier states. */
    public isRejected(): boolean {
        if (this.hasTerminalOrderStatus() || this.isCancelled() || this.isExpired()) return false;
        if (!this.hasErrorSignal()) return false;
        if (this._raw.actionCode === "2003" || this._raw.actionCode === "111") return true;
        const code = this._raw.params?.respCode;
        if (typeof code === "string" && code !== "" && code !== "00") return true;
        return this._raw.ErrorMessage?.toLowerCase().includes("payment is declined") ?? false;
    }

    /** Catch-all: true only when no other predicate matches. */
    public isFailed(): boolean {
        if (this.hasTerminalOrderStatus()) return false;
        return !this.isExpired() && !this.isCancelled() && !this.isRejected();
    }

    private hasTerminalOrderStatus(): boolean {
        return this.isSuccessful() || this.isRefunded() || this.isPending()
            || this.isReversed() || this.isPreAuthorized();
    }

    /** Any of: ErrorCode != "0"/undefined, params present, or actionCode present. */
    private hasErrorSignal(): boolean {
        const code = this._raw.ErrorCode;
        if (code === "0" || code === undefined) {
            return Boolean(this._raw.params || this._raw.actionCode);
        }
        return true;
    }

    // ─── Messages ────────────────────────────────────────────────────────

    /** Localized success/info message; falls back to getErrorMessage() for non-success states. */
    public getSuccessMessage(): string {
        if (this.isSuccessful()) {
            return this._raw.params?.respCode_desc
                ?? this._raw.actionCodeDescription
                ?? "Payment was successful";
        }
        if (this.isPending()) return "Payment is pending";
        if (this.isPreAuthorized()) return "Payment is pre-authorized (awaiting capture)";
        return this.getErrorMessage();
    }

    /** Localized failure message based on the active predicate. */
    public getErrorMessage(): string {
        if (this.isExpired()) return "Payment session expired";
        if (this.isCancelled()) return "Payment was cancelled";
        if (this.isReversed()) return "Payment authorization was voided";
        if (this.isRejected()) return "Your transaction was rejected";
        if (this.isRefunded()) return "Payment was refunded";
        if (this.isPreAuthorized()) return "Payment is pre-authorized (awaiting capture)";
        return this._raw.params?.respCode_desc
            ?? this._raw.actionCodeDescription
            ?? "Payment failed";
    }

    // ─── Amount verification ─────────────────────────────────────────────

    /**
     * Assert captured amount equals expected amount. Uses IEEE-754-safe
     * minor-unit comparison via toMinorUnits().
     *
     * @param expectedAmount Major-unit amount originally requested.
     * @throws SatimUnexpectedResponseError on missing/malformed/mismatched amount.
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
                `payment amount mismatch. Expected ${expectedMinor} (minor units), got ${actualMinor}`, "gateway",
            );
        }
        return true;
    }

    /** Raw response copy with PII (Ip, Pan, cardholderName, expiration) redacted. */
    public getRawResponse(): Record<string, unknown> {
        const copy: Record<string, unknown> = { ...this._raw };
        if (copy.Ip !== undefined) copy.Ip = "[REDACTED]";
        if (copy.Pan !== undefined) copy.Pan = "[REDACTED]";
        if (copy.cardholderName !== undefined) copy.cardholderName = "[REDACTED]";
        if (copy.expiration !== undefined) copy.expiration = "[REDACTED]";
        return copy;
    }
}

/** Parse a gateway minor-unit field into a major-unit number. */
function parseMinorField(raw: number | string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const str = String(raw).trim();
    if (!/^\d+$/.test(str)) return undefined;
    const parsed = Number(str);
    if (!isWholeMinorUnits(parsed) || parsed > Number.MAX_SAFE_INTEGER) return undefined;
    return parseFloat((parsed / 100).toFixed(2));
}

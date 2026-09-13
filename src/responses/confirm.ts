import { SatimUnexpectedResponseError } from "../exceptions.js";
import type { ConfirmOrderResponse } from "../types.js";
import { toMinorUnits, isWholeMinorUnits } from "../money.js";
import { validateConfirmSchema } from "./schema.js";

// Tolerate a trailing .0/.00: gateways serialise integer minor units through a decimal formatter.
const MINOR_UNIT_PATTERN = /^\d+(?:\.0+)?$/;

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

    public getAmount(): number | undefined {
        return parseMinorField(this._raw.Amount ?? this._raw.amount);
    }

    public getDepositAmount(): number | undefined {
        return parseMinorField(this._raw.depositAmount);
    }

    public isSuccessful(): boolean { return this._raw.OrderStatus === "2"; }

    public isRefunded(): boolean { return this._raw.OrderStatus === "4"; }

    public isPending(): boolean {
        // 5 = 3-D Secure in flight, 7 = pending payment; still in motion, never failures.
        const s = this._raw.OrderStatus;
        return s === "0" || s === "5" || s === "7";
    }

    public isReversed(): boolean { return this._raw.OrderStatus === "3"; }

    public isPreAuthorized(): boolean { return this._raw.OrderStatus === "1"; }

    public isPartiallyCaptured(): boolean { return this._raw.OrderStatus === "8"; }

    public isExpired(): boolean {
        if (this.hasKnownOrderStatus()) return false;
        return this._raw.actionCode === "-2007";
    }

    public isCancelled(): boolean {
        if (this.hasKnownOrderStatus() || this.isExpired()) return false;
        if (!this.hasErrorSignal()) return false;
        if (this._raw.actionCode === "10") return true;
        // English-only fallback; the SDK defaults to FR, so actionCode is authoritative.
        return this._raw.ErrorMessage?.toLowerCase().includes("payment is cancelled") ?? false;
    }

    public isRejected(): boolean {
        if (this._raw.OrderStatus === "6") return true;
        if (this.hasKnownOrderStatus() || this.isCancelled() || this.isExpired()) return false;
        if (!this.hasErrorSignal()) return false;
        if (this._raw.actionCode === "2003" || this._raw.actionCode === "111") return true;
        const code = this._raw.params?.respCode;
        if (typeof code === "string" && code !== "" && code !== "00") return true;
        return this._raw.ErrorMessage?.toLowerCase().includes("payment is declined") ?? false;
    }

    public isFailed(): boolean {
        if (this.hasKnownOrderStatus()) return false;
        return !this.isExpired() && !this.isCancelled() && !this.isRejected();
    }

    private hasKnownOrderStatus(): boolean {
        return this.isSuccessful() || this.isRefunded() || this.isPending()
            || this.isReversed() || this.isPreAuthorized() || this.isPartiallyCaptured()
            || this._raw.OrderStatus === "6";
    }

    private hasErrorSignal(): boolean {
        const code = this._raw.ErrorCode;
        if (code === "0" || code === undefined) {
            return Boolean(this._raw.params || this._raw.actionCode);
        }
        return true;
    }

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

    public verifyAmount(expectedAmount: number): void {
        const rawAmount = this._raw.Amount ?? this._raw.amount;
        if (rawAmount === undefined) {
            throw new SatimUnexpectedResponseError("missing amount in payment response.", "gateway");
        }
        const str = String(rawAmount).trim();
        if (!MINOR_UNIT_PATTERN.test(str)) {
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
    }

    public getRawResponse(): Record<string, unknown> {
        const copy = structuredClone(this._raw) as Record<string, unknown>;
        if (copy.Ip !== undefined) copy.Ip = "[REDACTED]";
        if (copy.Pan !== undefined) copy.Pan = "[REDACTED]";
        if (copy.cardholderName !== undefined) copy.cardholderName = "[REDACTED]";
        if (copy.expiration !== undefined) copy.expiration = "[REDACTED]";
        return copy;
    }
}

function parseMinorField(raw: number | string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const str = String(raw).trim();
    if (!MINOR_UNIT_PATTERN.test(str)) return undefined;
    const parsed = Number(str);
    if (!isWholeMinorUnits(parsed) || parsed > Number.MAX_SAFE_INTEGER) return undefined;
    return parseFloat((parsed / 100).toFixed(2));
}

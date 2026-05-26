/**
 * `ConfirmResponse`: typed wrapper for `/confirmOrder`, `/getOrderStatus`,
 * `/refund`, and `/reverse` results.
 *
 * # Status predicate contract
 *
 * The nine predicates exposed by this class are **mutually exclusive**.
 * For any well-formed gateway response, exactly one returns `true`.
 *
 * Dependency chain (acyclic):
 *
 *     Leaves (OrderStatus comparisons):
 *       isSuccessful, isPending, isReversed, isRefunded, isPreAuthorized
 *
 *     Composites:
 *       isExpired   → leaves
 *       isCancelled → leaves, isExpired
 *       isRejected  → leaves, isExpired, isCancelled
 *       isFailed    → catch-all (true only when all eight predicates above are false)
 *
 * Adding a tenth predicate requires updating the exclusion list of every
 * predicate that comes after it in the chain. No predicate may call
 * `isFailed` — that would introduce a cycle.
 *
 * # PII redaction
 *
 * `getRawResponse()` redacts `Ip`, `Pan`, `cardholderName`, and `expiration`.
 * Typed accessors return the unredacted values; callers must request
 * cardholder data explicitly via named getters.
 *
 * # Amount verification
 *
 * `verifyAmount()` uses the {@link toMinorUnits} IEEE-754-safe pipeline
 * for comparison. `Satim.confirm()` calls it automatically on
 * `isSuccessful()` responses — there is no way for a caller to skip it.
 * @file
 */

import { SatimUnexpectedResponseError } from "../exceptions";
import type { ConfirmOrderResponse } from "../types";
import { toMinorUnits, isWholeMinorUnits } from "../money";
import { validateConfirmSchema } from "./schema";

/**
 * Immutable wrapper around an order-management response.
 *
 * Invariants:
 * - `_raw` is a deep clone validated and normalised at construction.
 * - No mutator methods are exposed; the wrapper cannot affect SDK state.
 */
export class ConfirmResponse {
    private readonly _raw: ConfirmOrderResponse;

    /**
     * Validates and deep-clones the gateway payload. Normalises `OrderStatus`,
     * `ErrorCode`, `actionCode` to string (or `undefined`).
     * @throws {@link SatimUnexpectedResponseError} on schema violations.
     */
    constructor(raw: ConfirmOrderResponse) {
        validateConfirmSchema(raw);
        this._raw = structuredClone(raw);
    }

    // ─── PII-bearing accessors ───────────────────────────────────────────
    // Each returns the unredacted gateway value. Callers must request these
    // explicitly — the raw-response accessor below redacts them.

    /** @returns Cardholder IP address as reported by the gateway, or `undefined`. */
    public getIpAddress(): string | undefined { return this._raw.Ip; }
    /** @returns Cardholder name as printed on the card, or `undefined`. */
    public getCardHolderName(): string | undefined { return this._raw.cardholderName; }
    /** @returns Card expiry in YYYYMM format, or `undefined`. */
    public getCardExpiry(): string | undefined { return this._raw.expiration; }
    /** @returns Masked PAN (e.g. `4111**1111`) as redacted by the gateway, or `undefined`. */
    public getCardPan(): string | undefined { return this._raw.Pan; }
    /** @returns Issuer-generated approval code, or `undefined` for non-success responses. */
    public getApprovalCode(): string | undefined { return this._raw.approvalCode; }
    /** @returns The order number as echoed by the gateway, or `undefined`. */
    public getOrderNumber(): string | undefined {
        return this._raw.OrderNumber ?? this._raw.orderNumber;
    }

    /**
     * Captured amount in major units (e.g. DA). Returns `undefined` when the
     * gateway value is absent, non-satim-module, fractional, or exceeds
     * `Number.MAX_SAFE_INTEGER` — these cases indicate a malformed response
     * that should not be silently coerced. Callers needing strictness should
     * also call {@link verifyAmount}.
     */
    public getAmount(): number | undefined {
        return parseMinorField(this._raw.Amount ?? this._raw.amount);
    }

    /**
     * Actually-debited amount in major units.
     *
     * For standard captures, equals {@link getAmount}. For partial captures
     * (pre-auth flows), may be less than the original hold.
     *
     * Same null-vs-malformed semantics as {@link getAmount}.
     */
    public getDepositAmount(): number | undefined {
        return parseMinorField(this._raw.depositAmount);
    }

    // ─── Leaf predicates (mutually exclusive: at most one returns true) ──

    /** OrderStatus `"2"`: deposited (success). */
    public isSuccessful(): boolean { return this._raw.OrderStatus === "2"; }
    /** OrderStatus `"4"`: refunded. */
    public isRefunded(): boolean { return this._raw.OrderStatus === "4"; }
    /** OrderStatus `"0"`: registered but not paid yet. */
    public isPending(): boolean { return this._raw.OrderStatus === "0"; }
    /** OrderStatus `"3"`: authorization voided / reversed. */
    public isReversed(): boolean { return this._raw.OrderStatus === "3"; }
    /** OrderStatus `"1"`: funds held, awaiting capture. */
    public isPreAuthorized(): boolean { return this._raw.OrderStatus === "1"; }

    // ─── Composite predicates ────────────────────────────────────────────
    // Each early-returns `false` when any earlier predicate in the chain
    // is `true`. Reads like a series of `if-else` even though it's spread
    // across methods — the contract above enumerates the order.

    /** Session timed out (`actionCode === "-2007"`), only when no terminal OrderStatus is present. */
    public isExpired(): boolean {
        if (this.hasTerminalOrderStatus()) return false;
        return this._raw.actionCode === "-2007";
    }

    /** Customer cancelled (`actionCode === "10"` or message matches "payment is cancelled"). */
    public isCancelled(): boolean {
        if (this.hasTerminalOrderStatus() || this.isExpired()) return false;
        if (!this.hasErrorSignal()) return false;
        if (this._raw.actionCode === "10") return true;
        return this._raw.ErrorMessage?.toLowerCase().includes("payment is cancelled") ?? false;
    }

    /**
     * Bank declined (`actionCode ∈ {"2003","111"}`, or `respCode` outside
     * `{"", "00"}`, or message matches "payment is declined").
     */
    public isRejected(): boolean {
        if (this.hasTerminalOrderStatus() || this.isCancelled() || this.isExpired()) return false;
        if (!this.hasErrorSignal()) return false;
        if (this._raw.actionCode === "2003" || this._raw.actionCode === "111") return true;
        const code = this._raw.params?.respCode;
        if (typeof code === "string" && code !== "" && code !== "00") return true;
        return this._raw.ErrorMessage?.toLowerCase().includes("payment is declined") ?? false;
    }

    /**
     * Catch-all failure predicate — `true` iff every other predicate is `false`.
     * Mutual-exclusivity contract enforcement point: any response that does
     * not fit a narrower predicate lands here.
     */
    public isFailed(): boolean {
        if (this.hasTerminalOrderStatus()) return false;
        return !this.isExpired() && !this.isCancelled() && !this.isRejected();
    }

    /** True if any of the five leaf OrderStatus predicates matches. Used by composites. */
    private hasTerminalOrderStatus(): boolean {
        return this.isSuccessful() || this.isRefunded() || this.isPending()
            || this.isReversed() || this.isPreAuthorized();
    }

    /**
     * True iff any of: `ErrorCode != "0" && != undefined`, `params`
     * present, or `actionCode` present. Used by `isCancelled` and
     * `isRejected` to distinguish "real error response" from "absent
     * response with no diagnostic fields".
     */
    private hasErrorSignal(): boolean {
        const code = this._raw.ErrorCode;
        if (code === "0" || code === undefined) {
            return Boolean(this._raw.params || this._raw.actionCode);
        }
        return true;
    }

    // ─── Messages ────────────────────────────────────────────────────────

    /**
     * Localised success/info message. Falls back to {@link getErrorMessage}
     * for non-success terminal states.
     *
     * Source order on success: `params.respCode_desc`, then
     * `actionCodeDescription`, then a fixed English fallback.
     */
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

    /**
     * Localised failure message keyed to the active predicate.
     *
     * For declined payments, the message is the SDK's generic
     * `"Your transaction was rejected"` rather than the gateway's specific
     * `respCode_desc` (e.g. `"Do not honor"`). Callers needing the raw
     * gateway reason should read it from {@link getRawResponse}.
     */
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
     * Assert captured amount equals `expectedAmount`. Compares minor-unit
     * integers via the same IEEE-754-safe {@link toMinorUnits} pipeline
     * used at registration.
     *
     * Sole defence against partial-capture manipulation. `Satim.confirm()`
     * calls this automatically on `isSuccessful()` responses — bypassing
     * requires constructing `ConfirmResponse` directly, which also
     * bypasses the gateway call entirely.
     *
     * @throws {@link SatimUnexpectedResponseError} when the gateway amount
     *         is absent, non-satim-module, fractional, or mismatches.
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

    /**
     * Shallow copy of the raw gateway response with cardholder PII redacted.
     *
     * Redacted fields: `Ip`, `Pan`, `cardholderName`, `expiration`.
     *
     * Use for debugging, logging, error reporting. Mutating the returned
     * object does not affect this wrapper. For PII access, call the
     * dedicated `getCardPan` / `getCardHolderName` / `getCardExpiry` /
     * `getIpAddress` methods.
     */
    public getRawResponse(): Record<string, unknown> {
        const copy: Record<string, unknown> = { ...this._raw };
        if (copy.Ip !== undefined) copy.Ip = "[REDACTED]";
        if (copy.Pan !== undefined) copy.Pan = "[REDACTED]";
        if (copy.cardholderName !== undefined) copy.cardholderName = "[REDACTED]";
        if (copy.expiration !== undefined) copy.expiration = "[REDACTED]";
        return copy;
    }
}

/**
 * Parse a gateway minor-unit field into a major-unit number, or `undefined`
 * for absent / non-satim-module / fractional / oversize input.
 */
function parseMinorField(raw: number | string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const str = String(raw).trim();
    if (!/^\d+$/.test(str)) return undefined;
    const parsed = Number(str);
    if (!isWholeMinorUnits(parsed) || parsed > Number.MAX_SAFE_INTEGER) return undefined;
    return parseFloat((parsed / 100).toFixed(2));
}

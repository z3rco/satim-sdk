/**
 * Runtime schema validators for SATIM gateway responses.
 * Normalizes number→string coercions for fields the spec sends inconsistently.
 * @file
 */

import { SatimUnexpectedResponseError } from "../exceptions";
import type { RegisterOrderResponse, ConfirmOrderResponse } from "../types";

function isObject(raw: unknown): raw is Record<string, unknown> {
    return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/** Validate /register.do response shape. */
export function validateRegisterSchema(raw: unknown): asserts raw is RegisterOrderResponse {
    if (!isObject(raw)) {
        throw new SatimUnexpectedResponseError("Malformed registration response: not an object", "gateway");
    }
    if (typeof raw.orderId !== "string" || !raw.orderId) {
        throw new SatimUnexpectedResponseError("Malformed registration response: missing or invalid orderId", "gateway");
    }
    if (typeof raw.formUrl !== "string" || !raw.formUrl) {
        throw new SatimUnexpectedResponseError("Malformed registration response: missing or invalid formUrl", "gateway");
    }
    if (raw.errorCode !== undefined && typeof raw.errorCode !== "string") {
        throw new SatimUnexpectedResponseError("Malformed registration response: errorCode must be a string", "gateway");
    }
}

/** Validate order-management response shape; normalizes OrderStatus/ErrorCode/actionCode to strings. */
export function validateConfirmSchema(raw: unknown): asserts raw is ConfirmOrderResponse {
    if (!isObject(raw)) {
        throw new SatimUnexpectedResponseError("Malformed order response: not an object", "gateway");
    }
    coerceNumericString(raw, "OrderStatus");
    coerceNumericString(raw, "ErrorCode");
    coerceNumericString(raw, "actionCode");
}

function coerceNumericString(raw: Record<string, unknown>, field: string): void {
    const v = raw[field];
    if (v === undefined) return;
    if (typeof v === "number") { raw[field] = String(v); return; }
    if (typeof v !== "string") {
        throw new SatimUnexpectedResponseError(
            `Malformed order response: ${field} must be a string or number`, "gateway",
        );
    }
}

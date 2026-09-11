import { SatimUnexpectedResponseError } from "../exceptions.js";
import type { RegisterOrderResponse, ConfirmOrderResponse } from "../types.js";

function isObject(raw: unknown): raw is Record<string, unknown> {
    return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

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
    coerceNumericString(raw, "errorCode");
}

export function validateConfirmSchema(raw: unknown): asserts raw is ConfirmOrderResponse {
    if (!isObject(raw)) {
        throw new SatimUnexpectedResponseError("Malformed order response: not an object", "gateway");
    }
    coerceNumericString(raw, "OrderStatus");
    coerceNumericString(raw, "ErrorCode");
    coerceNumericString(raw, "actionCode");
}

// The gateway sends these numeric-looking fields as a JSON number on some endpoints, a string on others.
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

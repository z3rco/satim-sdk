/**
 * Runtime schema validators for SATIM gateway responses.
 *
 * The SATIM/BPC spec is inconsistent about whether numeric-looking fields
 * (`OrderStatus`, `ErrorCode`, `actionCode`) arrive as strings or numbers,
 * so these validators normalise them to string for downstream `=== "2"`
 * comparisons. Runs at the SDK boundary inside `RegisterResponse` and
 * `ConfirmResponse` constructors.
 * @file
 */

import { SatimUnexpectedResponseError } from "../exceptions.js";
import type { RegisterOrderResponse, ConfirmOrderResponse } from "../types.js";

/** True for non-array plain objects (excludes `null`, arrays, primitives). */
function isObject(raw: unknown): raw is Record<string, unknown> {
    return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * Assert `raw` matches `RegisterOrderResponse` shape: non-empty
 * `orderId`/`formUrl` strings, and `errorCode` (if present) a string.
 * @throws {@link SatimUnexpectedResponseError} with `errorCategory: "gateway"`.
 */
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

/**
 * Assert `raw` matches `ConfirmOrderResponse` shape and normalise
 * spec-inconsistent numeric fields (`OrderStatus`, `ErrorCode`,
 * `actionCode`) to strings. Mutates `raw` in place — safe because the
 * caller immediately `structuredClone`s the result.
 * @throws {@link SatimUnexpectedResponseError} with `errorCategory: "gateway"`
 *         when `raw` is not an object or a coerced field has a type
 *         other than `string | number | undefined`.
 */
export function validateConfirmSchema(raw: unknown): asserts raw is ConfirmOrderResponse {
    if (!isObject(raw)) {
        throw new SatimUnexpectedResponseError("Malformed order response: not an object", "gateway");
    }
    coerceNumericString(raw, "OrderStatus");
    coerceNumericString(raw, "ErrorCode");
    coerceNumericString(raw, "actionCode");
}

/**
 * Coerce a number-or-string field to string, in place. Reject other types.
 * @throws {@link SatimUnexpectedResponseError} when `raw[field]` is
 *         neither `undefined`, `number`, nor `string`.
 */
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

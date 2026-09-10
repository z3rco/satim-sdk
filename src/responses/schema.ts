/**
 * Runtime schema validators for SATIM gateway responses.
 *
 * The SATIM/BPC spec is inconsistent about whether numeric-looking fields
 * (`OrderStatus`, `ErrorCode`, `actionCode`) arrive as JSON strings or
 * numbers — examples in the official docs show both. These validators
 * normalise everything to string so downstream predicate comparisons
 * (`=== "2"`) work regardless of the gateway's serialisation choice.
 *
 * Validation runs at the SDK boundary inside `RegisterResponse` and
 * `ConfirmResponse` constructors. Malformed payloads are rejected with
 * {@link SatimUnexpectedResponseError} before any caller code sees them.
 * @file
 */

import { SatimUnexpectedResponseError } from "../exceptions.js";
import type { RegisterOrderResponse, ConfirmOrderResponse } from "../types.js";

/** True for non-array plain objects (excludes `null`, arrays, primitives). */
function isObject(raw: unknown): raw is Record<string, unknown> {
    return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * Assert that `raw` matches `RegisterOrderResponse` shape. On return, `orderId`
 * and `formUrl` are confirmed non-empty strings; `errorCode` (if present) is
 * confirmed string.
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
 * Assert that `raw` matches `ConfirmOrderResponse` shape and normalise
 * spec-inconsistent numeric fields (`OrderStatus`, `ErrorCode`, `actionCode`)
 * to strings.
 *
 * Mutates `raw` in place. Safe because the caller (`ConfirmResponse`
 * constructor) immediately `structuredClone`s the result.
 *
 * @throws {@link SatimUnexpectedResponseError} with `errorCategory: "gateway"`
 *         when `raw` is not an object or any coerced field has a type
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
 *
 * Preconditions: `raw` is a plain object.
 *
 * Postcondition: `raw[field]` is `undefined` or `string`.
 *
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

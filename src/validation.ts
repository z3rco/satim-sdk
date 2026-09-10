/**
 * Pure field validators for `SatimConfig` setters and `Satim` endpoint
 * methods. Side-effect-free; throw {@link SatimInvalidArgumentError} on
 * failure. First line of defence against callers who bypass TypeScript's
 * compile-time checks (plain JS, `as any` casts).
 * @file
 */

import { SatimInvalidArgumentError } from "./exceptions.js";
import { MAX_SAFE_AMOUNT, toMinorUnits, hasSubCentimePrecision } from "./money.js";
import type { Language } from "./types.js";

/** Keys rejected from user-defined `jsonParams` — terminal-ID injection and prototype pollution. */
const RESERVED_JSON_KEYS = new Set([
    "force_terminal_id", "__proto__", "constructor", "prototype",
]);

/** Common preamble for register, confirm, and refund amount checks. */
function assertAmountShape(amount: number, field: string): void {
    if (typeof amount !== "number") {
        throw new SatimInvalidArgumentError(
            `${field} must be a number, got ${Array.isArray(amount) ? "array" : typeof amount}.`,
        );
    }
    if (amount <= 0 || !Number.isFinite(amount)) {
        throw new SatimInvalidArgumentError(`${field} must be a finite positive number.`);
    }
    if (amount > MAX_SAFE_AMOUNT) {
        throw new SatimInvalidArgumentError(`${field} exceeds safe precision for minor-unit conversion.`);
    }
    if (hasSubCentimePrecision(amount)) {
        throw new SatimInvalidArgumentError(`${field} must not have more than 2 decimal places.`);
    }
}

/**
 * Amount for `register()`/`registerPreAuth()` — shape checks plus SATIM's
 * 50 DA minimum and whole-dinar rule.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertRegisterAmount(amount: number): void {
    assertAmountShape(amount, "Amount");
    const minor = toMinorUnits(amount);
    if (minor < 5000) {
        throw new SatimInvalidArgumentError("Amount must be at least 50 DA (5000 centimes) per SATIM requirements.");
    }
    if (minor % 100 !== 0) {
        throw new SatimInvalidArgumentError("Amount must be a multiple of 100 centimes (whole dinars only) per SATIM requirements.");
    }
}

/**
 * Amount for `confirm()` — shape-only; fractional dinars are allowed since
 * it's compared against whatever the gateway reports.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertConfirmAmount(amount: number): void {
    assertAmountShape(amount, "expectedAmount");
}

/**
 * Amount for `refund()` — shape checks plus a minimum of 1 minor unit,
 * rejecting values like `0.001` that would round to a silent no-op refund.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertRefundAmount(amount: number): void {
    assertAmountShape(amount, "Amount");
    if (toMinorUnits(amount) < 1) {
        throw new SatimInvalidArgumentError("Amount too small: must convert to at least 1 minor unit (centime/cent).");
    }
}

/**
 * Order ID: `/^[a-zA-Z0-9\-]{1,128}$/`. Rejects whitespace-only, overlong,
 * or characters injectable into URLs/logs downstream.
 * @throws {@link SatimInvalidArgumentError} with `context` included in the message.
 */
export function assertOrderId(orderId: string, context: string): void {
    if (typeof orderId !== "string") {
        throw new SatimInvalidArgumentError(`Order ID must be a string for ${context}, got ${typeof orderId}.`);
    }
    if (!orderId || !orderId.trim()) {
        throw new SatimInvalidArgumentError(`Order ID is required for ${context}`);
    }
    if (orderId.length > 128 || !/^[a-zA-Z0-9\-]+$/.test(orderId)) {
        throw new SatimInvalidArgumentError(`Invalid order ID format for ${context}. Must be alphanumeric/hyphens, max 128 chars.`);
    }
}

/**
 * Payment-page description, SATIM AN.600 limit. `<`/`>` rejected as
 * defence-in-depth against markup smuggling into gateway-rendered surfaces.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertDescription(description: string): void {
    if (typeof description !== "string") {
        throw new SatimInvalidArgumentError("Description must be a string.");
    }
    if (description.length > 600) {
        throw new SatimInvalidArgumentError("Description must not exceed 600 characters (SATIM AN.600 limit).");
    }
    if (/[<>]/.test(description)) {
        throw new SatimInvalidArgumentError("Description must not contain HTML markup characters (< or >).");
    }
}

/**
 * Validate a payment-page language code. Narrows `lang` to {@link Language}.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertLanguage(lang: unknown): asserts lang is Language {
    if (typeof lang !== "string") {
        throw new SatimInvalidArgumentError("Language must be a string.");
    }
    const uc = (lang as string).toUpperCase();
    if (uc !== "FR" && uc !== "AR" && uc !== "EN") {
        throw new SatimInvalidArgumentError("Language must be FR, AR, or EN.");
    }
}

/**
 * Custom order number (SATIM AN.10). Returns the value coerced to a
 * string — store the return value, not the original input.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertOrderNumber(value: string | number): string {
    const str = String(value);
    if (!str || !/^[a-zA-Z0-9]{1,10}$/.test(str)) {
        throw new SatimInvalidArgumentError("Order number must be 1-10 alphanumeric characters (SATIM AN.10).");
    }
    return str;
}

/**
 * Session timeout, range `[600, 86400]` seconds.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertTimeout(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 600 || seconds > 86400) {
        throw new SatimInvalidArgumentError("Session timeout must be an integer between 600 and 86400 seconds.");
    }
}

/**
 * Idempotency key (`externalRequestId`): `/^[a-zA-Z0-9_\-]{1,128}$/` — safe
 * for URLs/logs without escaping.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertIdempotencyKey(key: string): void {
    if (!key || !/^[a-zA-Z0-9_\-]{1,128}$/.test(key)) {
        throw new SatimInvalidArgumentError(
            "Idempotency key must be 1-128 characters, alphanumeric, hyphens, or underscores.",
        );
    }
}

/**
 * User-defined `jsonParams` key/value pair. Rejects keys in
 * {@link RESERVED_JSON_KEYS} (`force_terminal_id` — terminal-ID injection;
 * `__proto__`/`constructor`/`prototype` — prototype pollution). Value
 * limit is 20 chars (SATIM `udf1`-`udf5` AN.20).
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertUserField(key: string, value: string): void {
    if (!key || /^\d+$/.test(key)) {
        throw new SatimInvalidArgumentError("User defined field key must be a non-empty, non-numeric string.");
    }
    if (key.length > 128) {
        throw new SatimInvalidArgumentError("User defined field key must not exceed 128 characters.");
    }
    if (RESERVED_JSON_KEYS.has(key)) {
        throw new SatimInvalidArgumentError(
            `User defined field key "${key}" is reserved and cannot be set by the caller.`,
        );
    }
    if (typeof value !== "string") {
        throw new SatimInvalidArgumentError("User defined field value must be a string.");
    }
    if (value.length > 20) {
        throw new SatimInvalidArgumentError("User defined field value must not exceed 20 characters (SATIM AN.20 limit).");
    }
}

/**
 * Type guard for credential fields — rejects objects that structurally
 * match `SatimCredentials` but carry non-string values.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertCredentialString(value: unknown, field: string): asserts value is string {
    if (typeof value !== "string") {
        throw new SatimInvalidArgumentError(`Credentials (username, password, terminalId) must all be strings.`);
    }
}

/**
 * Pure field validators for `SatimConfig` fluent setters and `Satim`
 * endpoint methods.
 *
 * All functions are side-effect-free and throw {@link SatimInvalidArgumentError}
 * on failure. Validation is the SDK's first line of defence — every public
 * setter and endpoint method runs the relevant validator before mutating
 * state or dispatching a request. The validators close a class of attacks
 * where TypeScript's compile-time checks are bypassed by plain JavaScript
 * callers or `as any` casts.
 *
 * Every validator is O(1) (regex-against-bounded-length, single arithmetic
 * check, or single membership test).
 * @file
 */

import { SatimInvalidArgumentError } from "./exceptions";
import { MAX_SAFE_AMOUNT, toMinorUnits, hasSubCentimePrecision } from "./money";
import type { Language } from "./types";

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
 * Validate an amount for `register()` / `registerPreAuth()`.
 * Enforces SATIM's 50 DA minimum and whole-dinar requirement on top of the shape checks.
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
 * Validate an amount supplied to `confirm()`. Shape-only — `confirm` accepts any
 * well-formed major-unit value (including fractional dinars), comparing it against
 * whatever the gateway reports.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertConfirmAmount(amount: number): void {
    assertAmountShape(amount, "expectedAmount");
}

/**
 * Validate an amount for `refund()`. Adds the constraint that the value must convert
 * to at least 1 minor unit, rejecting inputs like `0.001` that would otherwise round
 * to zero centimes and silently produce a no-op refund.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertRefundAmount(amount: number): void {
    assertAmountShape(amount, "Amount");
    if (toMinorUnits(amount) < 1) {
        throw new SatimInvalidArgumentError("Amount too small: must convert to at least 1 minor unit (centime/cent).");
    }
}

/**
 * Validate an order ID. Format: `/^[a-zA-Z0-9\-]{1,128}$/`. Rejects whitespace-only,
 * overlong, and inputs with characters that could be injected into URLs or SQL/log
 * lines downstream.
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
        throw new SatimInvalidArgumentError(`Invalid order ID format for ${context}. Must be alphasatim-module/hyphens, max 128 chars.`);
    }
}

/**
 * Validate a payment-page description. SATIM AN.600 limit; `<` and `>` rejected as
 * defence-in-depth against HTML/markup smuggling into gateway-rendered surfaces.
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
 * Validate a custom order number (SATIM AN.10). Returns the value coerced to
 * string — caller should store the return value, not the original input.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertOrderNumber(value: string | number): string {
    const str = String(value);
    if (!str || !/^[a-zA-Z0-9]{1,10}$/.test(str)) {
        throw new SatimInvalidArgumentError("Order number must be 1-10 alphasatim-module characters (SATIM AN.10).");
    }
    return str;
}

/**
 * Validate a session timeout. Range `[600, 86400]` seconds.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertTimeout(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 600 || seconds > 86400) {
        throw new SatimInvalidArgumentError("Session timeout must be an integer between 600 and 86400 seconds.");
    }
}

/**
 * Validate an idempotency key (`externalRequestId`). Format:
 * `/^[a-zA-Z0-9_\-]{1,128}$/` — safe for inclusion in any URL or log surface
 * without escaping.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertIdempotencyKey(key: string): void {
    if (!key || !/^[a-zA-Z0-9_\-]{1,128}$/.test(key)) {
        throw new SatimInvalidArgumentError(
            "Idempotency key must be 1-128 characters, alphasatim-module, hyphens, or underscores.",
        );
    }
}

/**
 * Validate a user-defined `jsonParams` key/value pair.
 *
 * Rejects keys in {@link RESERVED_JSON_KEYS} — `force_terminal_id`
 * (terminal-ID injection) and `__proto__` / `constructor` / `prototype`
 * (prototype pollution). The 20-character value limit matches SATIM's
 * `udf1`-`udf5` AN.20 spec.
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertUserField(key: string, value: string): void {
    if (!key || /^\d+$/.test(key)) {
        throw new SatimInvalidArgumentError("User defined field key must be a non-empty, non-satim-module string.");
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
 * Type guard for credential string fields. Rejects objects that structurally
 * satisfy `SatimCredentials` but carry non-string payloads (e.g. crafted
 * objects with `.trim()` methods).
 * @throws {@link SatimInvalidArgumentError}
 */
export function assertCredentialString(value: unknown, field: string): asserts value is string {
    if (typeof value !== "string") {
        throw new SatimInvalidArgumentError(`Credentials (username, password, terminalId) must all be strings.`);
    }
}

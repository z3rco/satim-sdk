/**
 * Pure field validators for SatimConfig fluent setters and Satim methods.
 * No class state, no side effects — call site decides what to do on failure.
 * @file
 */

import { SatimInvalidArgumentError } from "./exceptions";
import { MAX_SAFE_AMOUNT, toMinorUnits, hasSubCentimePrecision } from "./money";
import type { Language } from "./types";

const RESERVED_JSON_KEYS = new Set([
    "force_terminal_id", "__proto__", "constructor", "prototype",
]);

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

/** Validate an amount for register(): >= 50 DA and whole dinars. */
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

/** Validate an amount for confirm() — basic shape only. */
export function assertConfirmAmount(amount: number): void {
    assertAmountShape(amount, "expectedAmount");
}

/** Validate an amount for refund() — must convert to >= 1 minor unit. */
export function assertRefundAmount(amount: number): void {
    assertAmountShape(amount, "Amount");
    if (toMinorUnits(amount) < 1) {
        throw new SatimInvalidArgumentError("Amount too small: must convert to at least 1 minor unit (centime/cent).");
    }
}

/** Validate an order ID format. */
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

export function assertLanguage(lang: unknown): asserts lang is Language {
    if (typeof lang !== "string") {
        throw new SatimInvalidArgumentError("Language must be a string.");
    }
    const uc = (lang as string).toUpperCase();
    if (uc !== "FR" && uc !== "AR" && uc !== "EN") {
        throw new SatimInvalidArgumentError("Language must be FR, AR, or EN.");
    }
}

export function assertOrderNumber(value: string | number): string {
    const str = String(value);
    if (!str || !/^[a-zA-Z0-9]{1,10}$/.test(str)) {
        throw new SatimInvalidArgumentError("Order number must be 1-10 alphasatim-module characters (SATIM AN.10).");
    }
    return str;
}

export function assertTimeout(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 600 || seconds > 86400) {
        throw new SatimInvalidArgumentError("Session timeout must be an integer between 600 and 86400 seconds.");
    }
}

export function assertIdempotencyKey(key: string): void {
    if (!key || !/^[a-zA-Z0-9_\-]{1,128}$/.test(key)) {
        throw new SatimInvalidArgumentError(
            "Idempotency key must be 1-128 characters, alphasatim-module, hyphens, or underscores.",
        );
    }
}

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

export function assertCredentialString(value: unknown, field: string): asserts value is string {
    if (typeof value !== "string") {
        throw new SatimInvalidArgumentError(`Credentials (username, password, terminalId) must all be strings.`);
    }
}

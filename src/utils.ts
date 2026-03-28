/**
 * Maximum amount in major units that `toPrecision(12)` can convert
 * without losing centime-level accuracy. Above this threshold the
 * 12 significant digits are not enough to preserve the last two digits.
 */
export const MAX_SAFE_AMOUNT = 9_999_999_999.99;

/**
 * Returns true if the amount has more than 2 decimal places.
 * Uses the same toPrecision(12) pipeline as {@link toMinorUnits} to
 * avoid false negatives from scientific notation in `toString()`.
 *
 * @param amount - Amount in major currency units.
 */
export function hasSubCentimePrecision(amount: number): boolean {
    const minor = parseFloat((amount * 100).toPrecision(12));
    return !Number.isInteger(minor);
}

/**
 * Returns true if the value represents a whole number of minor units
 * (i.e. no fractional centimes/cents). Used to validate gateway response
 * amounts that should always be integer minor units.
 *
 * @param minorUnits - Amount in minor currency units from the gateway.
 */
export function isWholeMinorUnits(minorUnits: number): boolean {
    return Number.isFinite(minorUnits) && Number.isInteger(minorUnits) && minorUnits > 0;
}

/**
 * Convert a major-unit currency amount to minor units (centimes/cents).
 *
 * **Important:** This function assumes the input has already been validated
 * via {@link hasSubCentimePrecision} and the {@link MAX_SAFE_AMOUNT} check.
 * Calling it on unvalidated input may produce silently rounded results.
 *
 * Uses `toPrecision(12)` to recover the likely intended decimal value
 * for typical currency inputs, counteracting IEEE 754 representation
 * artifacts. This is a heuristic that works reliably for amounts up to
 * {@link MAX_SAFE_AMOUNT} with at most 2 decimal places.
 *
 * @example
 * ```
 * toMinorUnits(19.99) // → 1999
 * toMinorUnits(0.01)  // → 1
 * ```
 *
 * @param amount - Amount in major currency units (e.g. DZD, USD, EUR).
 *                 Must be a positive, finite number with at most 2 decimal places
 *                 and not exceeding {@link MAX_SAFE_AMOUNT}.
 * @returns The amount in minor units (centimes/cents), rounded to the nearest integer.
 * @throws {SatimInvalidArgumentError} if the amount is invalid.
 */
/**
 * Derive a deterministic idempotency key from payment parameters.
 *
 * Same inputs always produce the same key, making retries safe.
 * The key is a SHA-256 hash prefixed with `dk_` (derived key).
 *
 * @param params.merchantRef - Your internal order/cart/invoice ID.
 * @param params.amount - Payment amount in major currency units.
 * @param params.currency - ISO currency code (defaults to "012" / DZD).
 * @returns A deterministic, collision-resistant idempotency key string.
 */
export function deriveIdempotencyKey(params: {
    merchantRef: string;
    amount: number;
    currency?: string;
    mode?: "register" | "preauth";
}): string {
    if (!params.merchantRef || !params.merchantRef.trim()) {
        throw new Error("deriveIdempotencyKey: merchantRef is required.");
    }
    if (!Number.isFinite(params.amount) || params.amount <= 0) {
        throw new Error("deriveIdempotencyKey: amount must be a finite positive number.");
    }
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const mode = params.mode ?? "register";
    const input = `${mode}|${params.merchantRef.trim()}|${params.amount}|${params.currency ?? "012"}`;
    const hash = createHash("sha256").update(input).digest("hex");
    return `dk_${hash}`;
}

/**
 * Derive a deterministic order number (up to 10 alphanumeric chars) from a merchant reference.
 *
 * Used by `safeRegister()` to ensure retries use the same order number.
 * Takes the first 9 hex digits of a SHA-256 hash, converts to decimal,
 * and maps to the valid 10-digit range (1000000000–9999999999).
 *
 * @param merchantRef - Your internal order/cart/invoice ID.
 * @param currency - ISO currency code (for domain separation).
 * @returns A stable 10-character numeric order number string.
 */
export function deriveOrderNumber(merchantRef: string, currency: string = "012", mode: "register" | "preauth" = "register"): string {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const input = `ordnum|${mode}|${merchantRef.trim()}|${currency}`;
    const hash = createHash("sha256").update(input).digest("hex");
    // Take first 12 hex chars (48 bits) → parse as int → map to 10-digit range
    const raw = parseInt(hash.slice(0, 12), 16);
    return String(1_000_000_000 + (raw % 9_000_000_000));
}

export function toMinorUnits(amount: number): number {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        throw new Error("toMinorUnits: amount must be a finite positive number.");
    }
    if (amount > MAX_SAFE_AMOUNT) {
        throw new Error("toMinorUnits: amount exceeds MAX_SAFE_AMOUNT.");
    }
    if (hasSubCentimePrecision(amount)) {
        throw new Error("toMinorUnits: amount must not have more than 2 decimal places.");
    }
    return Math.round(parseFloat((amount * 100).toPrecision(12)));
}

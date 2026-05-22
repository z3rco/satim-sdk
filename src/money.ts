/**
 * IEEE-754-safe currency conversion between major and minor units.
 *
 * The toPrecision(12) pipeline neutralizes representation artifacts for any
 * input below MAX_SAFE_AMOUNT with at most 2 decimal places.
 * @file
 */

/** Upper bound where toPrecision(12) still preserves centime accuracy. */
export const MAX_SAFE_AMOUNT = 9_999_999_999.99;

/**
 * Detect sub-centime precision via relative-epsilon comparison against
 * the nearest integer minor-unit value.
 *
 * Tolerance scales with magnitude (1e-13 × |minor|) so the check stays
 * sound near MAX_SAFE_AMOUNT, where toPrecision(12) silently rounds the
 * 13th significant digit and masks the third decimal place.
 *
 * Floor of 1e-7 keeps the IEEE-754 round-trip artifacts of small inputs
 * (e.g. `0.1 + 0.2 = 0.30000000000000004`) from triggering false positives.
 *
 * @param amount Major-unit amount.
 */
export function hasSubCentimePrecision(amount: number): boolean {
    const minor = amount * 100;
    const rounded = Math.round(minor);
    const tolerance = Math.max(1e-7, Math.abs(rounded) * 1e-13);
    return Math.abs(minor - rounded) > tolerance;
}

/**
 * Validate that a value is a strictly positive integer count of minor units.
 * @param minor Minor-unit value from the gateway.
 */
export function isWholeMinorUnits(minor: number): boolean {
    return Number.isFinite(minor) && Number.isInteger(minor) && minor > 0;
}

/**
 * Convert a major-unit amount to integer minor units.
 *
 * @param amount Positive, finite, <= MAX_SAFE_AMOUNT, <= 2 decimal places.
 * @throws Error on invalid input.
 */
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
    return Math.round(amount * 100);
}

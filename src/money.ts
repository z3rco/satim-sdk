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
 * Detect sub-centime precision using the same toPrecision(12) pipeline as
 * toMinorUnits, avoiding false negatives from scientific notation.
 * @param amount Major-unit amount.
 */
export function hasSubCentimePrecision(amount: number): boolean {
    return !Number.isInteger(parseFloat((amount * 100).toPrecision(12)));
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
    return Math.round(parseFloat((amount * 100).toPrecision(12)));
}

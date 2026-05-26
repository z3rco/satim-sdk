/**
 * IEEE-754-safe currency conversion between major and minor units.
 *
 * All amounts in the SDK pass through this module exactly once at each
 * boundary: caller input is converted to minor-unit integers before being
 * sent to the gateway, and gateway responses are converted back to major
 * units for callers. There is no float arithmetic on currency anywhere
 * else in the SDK.
 *
 * Sub-centime precision is detected via a relative-epsilon comparison
 * against the nearest integer minor-unit value:
 *
 *     |amount*100 - round(amount*100)| > max(1e-7, |round(amount*100)| × 1e-13)
 *
 * The relative term keeps the check sound across the full input range
 * (up to {@link MAX_SAFE_AMOUNT}). The 1e-7 floor avoids false positives
 * on small-magnitude IEEE-754 artifacts like `0.1 + 0.2 = 0.30000000000000004`.
 * @file
 */

/**
 * Upper bound where the relative-epsilon precision check remains sound.
 * Inputs above this are rejected by {@link toMinorUnits} outright.
 *
 * The numeric value (`9_999_999_999.99`) is chosen so that `amount * 100`
 * fits comfortably within `Number.MAX_SAFE_INTEGER` (~9.007e15) with
 * room for the relative-epsilon tolerance to detect sub-centime inputs.
 */
export const MAX_SAFE_AMOUNT = 9_999_999_999.99;

/**
 * Detect whether a major-unit amount has more than 2 decimal places.
 *
 * Returns `true` iff the IEEE-754 representation of `amount * 100` differs
 * from the nearest integer by more than the relative tolerance described
 * in the file header. Non-finite or non-numeric inputs return `false` —
 * this function is not the validation barrier; {@link toMinorUnits}
 * performs the upstream type and range checks.
 */
export function hasSubCentimePrecision(amount: number): boolean {
    const minor = amount * 100;
    const rounded = Math.round(minor);
    const tolerance = Math.max(1e-7, Math.abs(rounded) * 1e-13);
    return Math.abs(minor - rounded) > tolerance;
}

/**
 * Validate that a value is a strictly positive integer count of minor units.
 *
 * Used by `ConfirmResponse.verifyAmount` and `getAmount` to guard against
 * gateway responses that contain fractional or non-positive amounts.
 */
export function isWholeMinorUnits(minor: number): boolean {
    return Number.isFinite(minor) && Number.isInteger(minor) && minor > 0;
}

/**
 * Convert a major-unit amount to an integer count of minor units (centimes).
 *
 * This is the single conversion point for all caller amounts. Bypassing it
 * (e.g. computing `amount * 100` directly) would reintroduce the IEEE-754
 * silent-rounding vulnerability fixed by the relative-epsilon precision check.
 *
 * @throws Error when `amount` is not a finite positive number.
 * @throws Error when `amount` exceeds {@link MAX_SAFE_AMOUNT}.
 * @throws Error when `amount` has more than 2 decimal places.
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

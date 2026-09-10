/** IEEE-754-safe currency conversion between major and minor units.
 * Amounts cross this module exactly once at each boundary (caller input
 * to minor units out; gateway response to major units back) — no other
 * float currency arithmetic happens in the SDK.
 *
 * Sub-centime check (relative epsilon vs. nearest integer):
 *     |amount*100 - round(amount*100)| > max(1e-7, |round(amount*100)| × 1e-13)
 * The 1e-7 floor avoids false positives on artefacts like `0.1 + 0.2`.
 * @file
 */

/**
 * Upper bound where the relative-epsilon precision check stays sound;
 * {@link toMinorUnits} rejects inputs above this. Chosen so `amount * 100`
 * fits within `Number.MAX_SAFE_INTEGER` with room for the epsilon check.
 */
export const MAX_SAFE_AMOUNT = 9_999_999_999.99;

/**
 * True iff `amount * 100` differs from the nearest integer by more than
 * the relative tolerance (see file header). Non-finite/non-numeric input
 * returns `false` — {@link toMinorUnits} does the upstream range checks.
 */
export function hasSubCentimePrecision(amount: number): boolean {
    const minor = amount * 100;
    const rounded = Math.round(minor);
    const tolerance = Math.max(1e-7, Math.abs(rounded) * 1e-13);
    return Math.abs(minor - rounded) > tolerance;
}

/**
 * True iff `minor` is a finite, strictly positive integer. Used by
 * `verifyAmount`/`getAmount` to guard against fractional or non-positive
 * gateway amounts.
 */
export function isWholeMinorUnits(minor: number): boolean {
    return Number.isFinite(minor) && Number.isInteger(minor) && minor > 0;
}

/**
 * Convert a major-unit amount to an integer count of minor units (centimes).
 * The single conversion point for all caller amounts — bypassing it (e.g.
 * `amount * 100` directly) reintroduces the IEEE-754 silent-rounding bug
 * the epsilon check above fixes.
 *
 * @throws Error when `amount` is not finite/positive, exceeds {@link MAX_SAFE_AMOUNT}, or has more than 2 decimal places.
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

export const MAX_SAFE_AMOUNT = 9_999_999_999.99;

export function hasSubCentimePrecision(amount: number): boolean {
    const minor = amount * 100;
    const rounded = Math.round(minor);
    const tolerance = Math.max(1e-7, Math.abs(rounded) * 1e-13);
    return Math.abs(minor - rounded) > tolerance;
}

export function isWholeMinorUnits(minor: number): boolean {
    return Number.isFinite(minor) && Number.isInteger(minor) && minor > 0;
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
    return Math.round(amount * 100);
}

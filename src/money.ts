import { SatimInvalidArgumentError } from "./exceptions.js";

export const MAX_SAFE_AMOUNT = 9_999_999_999.99;

export function hasSubCentimePrecision(amount: number): boolean {
  const minor = amount * 100;
  const rounded = Math.round(minor);
  // 1e-7 floor avoids false positives on IEEE-754 artefacts like 0.1 + 0.2.
  const tolerance = Math.max(1e-7, Math.abs(rounded) * 1e-13);
  return Math.abs(minor - rounded) > tolerance;
}

export function isWholeMinorUnits(minor: number): boolean {
  return Number.isFinite(minor) && Number.isInteger(minor) && minor > 0;
}

// The single conversion point for caller amounts; bypassing it reintroduces silent-rounding bugs.
export function toMinorUnits(amount: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new SatimInvalidArgumentError('toMinorUnits: amount must be a finite positive number.');
  }
  if (amount > MAX_SAFE_AMOUNT) {
    throw new SatimInvalidArgumentError('toMinorUnits: amount exceeds MAX_SAFE_AMOUNT.');
  }
  if (hasSubCentimePrecision(amount)) {
    throw new SatimInvalidArgumentError(
      'toMinorUnits: amount must not have more than 2 decimal places.',
    );
  }
  const minor = Math.round(amount * 100);
  // A positive amount below half a centime rounds to 0; reject rather than silently convert to nothing.
  if (minor < 1) {
    throw new SatimInvalidArgumentError('toMinorUnits: amount is too small; it converts to 0 minor units.');
  }
  return minor;
}

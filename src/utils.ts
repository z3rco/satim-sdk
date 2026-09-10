/**
 * Backwards-compatibility re-export. Real implementations live in
 * {@link ./money} (currency conversion) and {@link ./idempotency} (key
 * derivation). No logic here — new code should import from the package
 * root instead.
 * @file
 */

export {
    MAX_SAFE_AMOUNT,
    hasSubCentimePrecision,
    isWholeMinorUnits,
    toMinorUnits,
} from "./money.js";

export {
    deriveIdempotencyKey,
    deriveOrderNumber,
} from "./idempotency.js";

/**
 * Backwards-compatibility re-export. Real implementations live in
 * money.ts (currency conversion) and idempotency.ts (key derivation).
 * @file
 */

export {
    MAX_SAFE_AMOUNT,
    hasSubCentimePrecision,
    isWholeMinorUnits,
    toMinorUnits,
} from "./money";

export {
    deriveIdempotencyKey,
    deriveOrderNumber,
} from "./idempotency";

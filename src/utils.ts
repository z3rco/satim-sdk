/**
 * Backwards-compatibility re-export.
 *
 * Tests and downstream consumers may import currency and idempotency
 * primitives from `./utils`; the actual implementations live in
 * {@link ./money} (currency conversion) and {@link ./idempotency}
 * (deterministic key derivation).
 *
 * No logic lives in this file. New code should import from the package
 * root: `import { toMinorUnits, deriveIdempotencyKey } from "satim-module"`.
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

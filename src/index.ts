/**
 * Public barrel export.
 *
 * Consumers should import the SDK's public surface from the package
 * root rather than reaching into individual modules:
 *
 *     import { Satim, SatimError, WebhookHandler } from "satim-module";
 *
 * Re-exports are direct (no aliasing or renaming). Adding to this file
 * extends the public API; removing from it is a breaking change.
 * @file
 */

export * from "./exceptions";
export * from "./types";
export { HttpClientService, type HttpClientOptions } from "./client";
export { type CircuitBreakerOptions } from "./client";
export * from "./Satim";
export { RegisterResponse } from "./responses/register";
export { ConfirmResponse } from "./responses/confirm";
export {
    MAX_SAFE_AMOUNT,
    hasSubCentimePrecision,
    isWholeMinorUnits,
    toMinorUnits,
} from "./money";
export {
    deriveIdempotencyKey,
    deriveOrderNumber,
    type Mode,
} from "./idempotency";
export {
    WebhookHandler,
    type WebhookHandlerOptions,
    type WebhookResult,
} from "./webhook/handler";

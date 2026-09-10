/**
 * Public barrel export.
 *
 * Consumers should import the SDK's public surface from the package
 * root rather than reaching into individual modules:
 *
 *     import { Satim, SatimError, WebhookHandler } from "satim-sdk";
 *
 * Re-exports are direct (no aliasing or renaming). Adding to this file
 * extends the public API; removing from it is a breaking change.
 * @file
 */

export * from "./exceptions.js";
export * from "./types.js";
export { HttpClientService, type HttpClientOptions } from "./client.js";
export { type CircuitBreakerOptions } from "./client.js";
export * from "./Satim.js";
export { RegisterResponse } from "./responses/register.js";
export { ConfirmResponse } from "./responses/confirm.js";
export {
    MAX_SAFE_AMOUNT,
    hasSubCentimePrecision,
    isWholeMinorUnits,
    toMinorUnits,
} from "./money.js";
export {
    deriveIdempotencyKey,
    deriveOrderNumber,
    type Mode,
} from "./idempotency.js";
export {
    WebhookHandler,
    type WebhookHandlerOptions,
    type WebhookResult,
    type WebhookOutcome,
    type WebhookRejectionReason,
} from "./webhook/handler.js";
export { sha256Hex, randomOrderNumber } from "./crypto.js";

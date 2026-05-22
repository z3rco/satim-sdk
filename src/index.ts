/**
 * Public barrel export. Consumers should import from "satim-module"
 * rather than reaching into individual modules.
 * @file
 */

export * from "./exceptions";
export * from "./types";
export { type HttpClientOptions, type CircuitBreakerOptions } from "./client";
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
} from "./idempotency";
export {
    WebhookHandler,
    type WebhookHandlerOptions,
    type WebhookResult,
} from "./webhook/handler";

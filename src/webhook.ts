/**
 * Backwards-compatibility re-export. Real implementation lives in
 * {@link ./webhook/handler}. No logic here — new code should import
 * from the package root instead.
 * @file
 */

export {
    WebhookHandler,
    type WebhookHandlerOptions,
    type WebhookResult,
    type WebhookOutcome,
    type WebhookRejectionReason,
} from "./webhook/handler.js";

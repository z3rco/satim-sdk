/**
 * Backwards-compatibility re-export. Real implementation lives in
 * webhook/handler.ts (plus rate-limiter.ts and extract.ts).
 * @file
 */

export {
    WebhookHandler,
    type WebhookHandlerOptions,
    type WebhookResult,
} from "./webhook/handler";

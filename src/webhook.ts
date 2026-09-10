/**
 * Backwards-compatibility re-export.
 *
 * Tests and downstream consumers may import the webhook handler from
 * `./webhook`; the actual implementation lives in
 * {@link ./webhook/handler}, with supporting primitives in
 * {@link ./webhook/rate-limiter} and {@link ./webhook/extract}.
 *
 * No logic lives in this file. New code should import from the package
 * root: `import { WebhookHandler } from "satim-sdk"`.
 * @file
 */

export {
    WebhookHandler,
    type WebhookHandlerOptions,
    type WebhookResult,
    type WebhookOutcome,
    type WebhookRejectionReason,
} from "./webhook/handler.js";

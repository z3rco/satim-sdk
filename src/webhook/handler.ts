import type { Satim } from "../Satim.js";
import type { ConfirmResponse } from "../responses/confirm.js";
import { SatimInvalidArgumentError, SatimMissingDataError } from "../exceptions.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { extractOrderId, extractParams } from "./extract.js";
import { verifyCallbackChecksum } from "./checksum.js";

export type WebhookRejectionReason =
    | "invalid_source"
    | "bad_signature"
    | "rate_limited"
    | "unknown_order";

export type WebhookOutcome =
    | { verified: true; result: WebhookResult }
    | { verified: false; reason: WebhookRejectionReason };

export interface WebhookResult {

    orderId: string;

    response: ConfirmResponse;

    duplicate: boolean;
}

export interface WebhookHandlerOptions {

    onResolveAmount: (orderId: string) => Promise<number | undefined | null> | number | undefined | null;

    onCheckDuplicate?: (orderId: string) => Promise<boolean> | boolean;

    onMarkProcessed?: (orderId: string) => Promise<void> | void;

    maxCallbacksPerWindow?: number;

    rateLimitWindowMs?: number;

    callbackSecret?: string;

    suppressMultiInstanceWarning?: boolean;
}

export class WebhookHandler {
    private readonly satim: Satim;
    private readonly onResolveAmount: WebhookHandlerOptions["onResolveAmount"];
    private readonly onCheckDuplicate: (orderId: string) => Promise<boolean> | boolean;
    private readonly onMarkProcessed: (orderId: string) => Promise<void> | void;
    private readonly rateLimiter: SlidingWindowRateLimiter;

    private readonly callbackSecret: string | undefined;

    private warnedAboutUncheckedSignature = false;

    private readonly processedSet = new Set<string>();

    private readonly inflightLocks = new Map<string, Promise<WebhookResult | null>>();

    constructor(satim: Satim, options: WebhookHandlerOptions) {
        if (!options.onResolveAmount) {
            throw new SatimMissingDataError(
                "onResolveAmount is required. The webhook handler must be able to look up " +
                "the expected amount for each order ID to verify payment integrity.",
            );
        }
        this.satim = satim;
        this.onResolveAmount = options.onResolveAmount;
        this.callbackSecret = options.callbackSecret;

        const usingFallback = !options.onCheckDuplicate && !options.onMarkProcessed;
        if (usingFallback && !options.suppressMultiInstanceWarning) {
            console.warn(
                "[satim-sdk] WebhookHandler: using in-memory duplicate tracking. " +
                "This is only safe for single-process deployments. " +
                "In multi-instance environments (Kubernetes, multiple dynos, serverless) " +
                "provide onCheckDuplicate and onMarkProcessed backed by a shared store " +
                "(e.g. Redis, your database). " +
                "Set suppressMultiInstanceWarning: true to silence this warning.",
            );
        }
        this.onCheckDuplicate = options.onCheckDuplicate
            ?? ((id) => this.processedSet.has(id));
        this.onMarkProcessed = options.onMarkProcessed
            ?? ((id) => { this.processedSet.add(id); });

        const maxCallbacks = options.maxCallbacksPerWindow ?? 100;
        const windowMs = options.rateLimitWindowMs ?? 60_000;
        if (!Number.isInteger(maxCallbacks) || maxCallbacks < 1) {
            throw new SatimInvalidArgumentError("maxCallbacksPerWindow must be a positive integer.");
        }
        if (!Number.isInteger(windowMs) || windowMs < 1000) {
            throw new SatimInvalidArgumentError("rateLimitWindowMs must be an integer >= 1000.");
        }
        this.rateLimiter = new SlidingWindowRateLimiter(maxCallbacks, windowMs);
    }

    async verify(source: unknown): Promise<WebhookResult | null> {
        const outcome = await this.inspect(source);
        return outcome.verified ? outcome.result : null;
    }

    async inspect(source: unknown): Promise<WebhookOutcome> {
        const orderId = extractOrderId(source);
        if (!orderId) return { verified: false, reason: "invalid_source" };

        const params = extractParams(source);
        if (this.callbackSecret) {
            if (!params || !verifyCallbackChecksum(params, this.callbackSecret)) {
                return { verified: false, reason: "bad_signature" };
            }
        // Gateway is signing but nobody configured a secret: warn once rather than ignore silently.
        } else if (params?.checksum && !this.warnedAboutUncheckedSignature) {

            this.warnedAboutUncheckedSignature = true;
            console.warn(
                "[satim-sdk] This callback carried a `checksum`, so your merchant profile "
                + "signs notifications — but no callbackSecret is configured, so the signature "
                + "is being ignored. Ask your bank for the shared secret and pass it as "
                + "`callbackSecret` to verify origin as well as state.",
            );
        }

        // Rate-limit after the signature check, so forged traffic can't exhaust the window.
        if (!this.rateLimiter.check()) return { verified: false, reason: "rate_limited" };

        const existing = this.inflightLocks.get(orderId);
        if (existing) {
            const first = await existing;
            return first
                ? { verified: true, result: { orderId, response: first.response, duplicate: true } }
                : { verified: false, reason: "unknown_order" };
        }

        const execution = this.executeVerify(orderId);
        this.inflightLocks.set(orderId, execution);
        let result: WebhookResult | null;
        try {
            result = await execution;
        } finally {
            this.inflightLocks.delete(orderId);
        }
        return result
            ? { verified: true, result }
            : { verified: false, reason: "unknown_order" };
    }

    private async executeVerify(orderId: string): Promise<WebhookResult | null> {

        const [isDuplicate, expectedAmount] = await Promise.all([
            this.onCheckDuplicate(orderId),
            this.onResolveAmount(orderId),
        ]);

        if (expectedAmount === undefined || expectedAmount === null) return null;

        // Replays re-read with status(); confirm() would re-fire the mutating acknowledgement.
        const response = isDuplicate
            ? await this.satim.status(orderId)
            : await this.satim.confirm(orderId, expectedAmount);

        if (isDuplicate && response.isSuccessful()) response.verifyAmount(expectedAmount);

        if (!isDuplicate && WebhookHandler.isTerminal(response)) await this.onMarkProcessed(orderId);
        return { orderId, response, duplicate: isDuplicate };
    }

    // Mark only truly final states: marking a pre-auth or declined order drops its later success as a duplicate.
    private static isTerminal(response: ConfirmResponse): boolean {
        return response.isSuccessful() || response.isRefunded() || response.isReversed();
    }
}

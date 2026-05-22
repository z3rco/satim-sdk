/**
 * Zero-trust webhook handler.
 *
 * Never trusts the callback payload — always re-fetches authoritative state
 * from SATIM via satim.confirm(). Strictly stronger than HMAC verification
 * because signatures prove origin but not currentness.
 * @file
 */

import type { Satim } from "../Satim";
import type { ConfirmResponse } from "../responses/confirm";
import { SatimInvalidArgumentError, SatimMissingDataError } from "../exceptions";
import { SlidingWindowRateLimiter } from "./rate-limiter";
import { extractOrderId } from "./extract";

/** Server-verified result of a webhook/callback invocation. */
export interface WebhookResult {
    orderId: string;
    /** Authoritative response fetched from SATIM via confirm(). */
    response: ConfirmResponse;
    /** True when this orderId was already fulfilled. */
    duplicate: boolean;
}

export interface WebhookHandlerOptions {
    /**
     * Resolve the expected major-unit amount for an orderId.
     * Return undefined/null to reject the callback as unknown.
     */
    onResolveAmount: (orderId: string) => Promise<number | undefined | null> | number | undefined | null;
    /**
     * Atomic check-and-mark duplicate detection. For multi-instance deployments
     * back this with Redis SETNX or DB INSERT ... ON CONFLICT — the SDK's
     * in-flight lock only serializes within a single Node.js process.
     */
    onCheckDuplicate?: (orderId: string) => Promise<boolean> | boolean;
    /** Called after a successful, non-duplicate verification. */
    onMarkProcessed?: (orderId: string) => Promise<void> | void;
    /** Max callbacks per sliding window. Default 100. */
    maxCallbacksPerWindow?: number;
    /** Sliding window duration in ms. Default 60000. */
    rateLimitWindowMs?: number;
    /** Suppress the multi-instance warning for confirmed single-process deployments. */
    suppressMultiInstanceWarning?: boolean;
}

/**
 * Zero-trust webhook handler.
 *
 * Built-in protections: replay rejection, rate limiting, amount verification,
 * orderId sanitization, per-orderId in-flight lock against double-fulfillment.
 */
export class WebhookHandler {
    private readonly satim: Satim;
    private readonly onResolveAmount: WebhookHandlerOptions["onResolveAmount"];
    private readonly onCheckDuplicate: (orderId: string) => Promise<boolean> | boolean;
    private readonly onMarkProcessed: (orderId: string) => Promise<void> | void;
    private readonly rateLimiter: SlidingWindowRateLimiter;
    private readonly processedSet = new Set<string>();
    /** Per-orderId in-flight lock — prevents the check-then-mark race within one process. */
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

        const usingFallback = !options.onCheckDuplicate && !options.onMarkProcessed;
        if (usingFallback && !options.suppressMultiInstanceWarning) {
            console.warn(
                "[satim-module] WebhookHandler: using in-memory duplicate tracking. " +
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

    /**
     * Verify a callback by re-fetching authoritative state from SATIM.
     *
     * Steps: extract orderId → rate limit → in-flight lock → duplicate check
     *      → resolve amount → confirm() → mark processed (unless pending).
     *
     * @param source Callback payload, URL, Request, or orderId string.
     * @returns WebhookResult on success; null when input is invalid, rate
     *          limited, or the order is unknown.
     */
    async verify(source: unknown): Promise<WebhookResult | null> {
        const orderId = extractOrderId(source);
        if (!orderId) return null;
        if (!this.rateLimiter.check()) return null;

        const existing = this.inflightLocks.get(orderId);
        if (existing) {
            const first = await existing.catch(() => null);
            return first ? { orderId, response: first.response, duplicate: true } : null;
        }

        const execution = this.executeVerify(orderId);
        this.inflightLocks.set(orderId, execution);
        try {
            return await execution;
        } finally {
            this.inflightLocks.delete(orderId);
        }
    }

    private async executeVerify(orderId: string): Promise<WebhookResult | null> {
        const isDuplicate = await this.onCheckDuplicate(orderId);
        if (isDuplicate) {
            const amount = await this.onResolveAmount(orderId);
            if (amount === undefined || amount === null) return null;
            const response = await this.satim.confirm(orderId, amount);
            return { orderId, response, duplicate: true };
        }

        const expectedAmount = await this.onResolveAmount(orderId);
        if (expectedAmount === undefined || expectedAmount === null) return null;

        const response = await this.satim.confirm(orderId, expectedAmount);
        if (!response.isPending()) await this.onMarkProcessed(orderId);
        return { orderId, response, duplicate: false };
    }
}

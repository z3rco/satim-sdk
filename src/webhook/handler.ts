/**
 * Zero-trust webhook handler for SATIM callbacks.
 *
 * Re-fetches authoritative state via `satim.confirm()` on every call,
 * which defeats replay/stale-webhook races that pass HMAC checks, and
 * verifies the amount against the merchant's source of truth. Adds a
 * rate limit, a per-orderId in-flight lock, and pluggable duplicate
 * detection for multi-instance deployments.
 * @file
 */

import type { Satim } from "../Satim.js";
import type { ConfirmResponse } from "../responses/confirm.js";
import { SatimInvalidArgumentError, SatimMissingDataError } from "../exceptions.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { extractOrderId } from "./extract.js";

/**
 * Why a callback did not produce a verified result.
 *
 * - `invalid_source` — no valid orderId could be extracted. Respond `400`.
 * - `rate_limited` — window full. Respond `429`/5xx so the gateway
 *   redelivers; a `200` here silently drops a real payment.
 * - `unknown_order` — `onResolveAmount` returned nullish. Respond `404`.
 */
export type WebhookRejectionReason = "invalid_source" | "rate_limited" | "unknown_order";

/**
 * Outcome of {@link WebhookHandler.inspect}: a verified result or the
 * specific reason verification did not happen.
 *
 * `verify()` collapses this to `WebhookResult | null`, losing the
 * distinction between "junk, drop it" and "busy, please resend". Prefer
 * `inspect()` in any handler that returns an HTTP status.
 */
export type WebhookOutcome =
    | { verified: true; result: WebhookResult }
    | { verified: false; reason: WebhookRejectionReason };

/** Server-verified result of a webhook/callback invocation. */
export interface WebhookResult {
    /** The validated order ID extracted from the source. */
    orderId: string;
    /**
     * Authoritative `ConfirmResponse` fetched from SATIM via `confirm()`.
     * Amount verification has already run on `isSuccessful()` responses.
     */
    response: ConfirmResponse;
    /**
     * `true` when this orderId had already been processed (per the
     * `onCheckDuplicate` strategy). Callers should NOT re-fulfil
     * downstream side effects when this is set.
     */
    duplicate: boolean;
}

/** Callbacks and limits for {@link WebhookHandler}. Only `onResolveAmount` is required. */
export interface WebhookHandlerOptions {
    /**
     * Resolve the expected major-unit amount for an orderId, typically a
     * database lookup. Return `undefined`/`null` to reject as an unknown
     * order — `verify()` returns `null` without calling the gateway.
     */
    onResolveAmount: (orderId: string) => Promise<number | undefined | null> | number | undefined | null;

    /**
     * Check whether `orderId` has already been processed.
     *
     * Multi-instance deployments MUST implement this and the mark
     * callback as a single atomic operation (Redis `SETNX`,
     * `INSERT … ON CONFLICT DO NOTHING`) — the handler's in-flight lock
     * only serialises within a single process.
     *
     * Default (single-process only): in-memory `Set`.
     */
    onCheckDuplicate?: (orderId: string) => Promise<boolean> | boolean;

    /**
     * Mark `orderId` as processed. Called only once the gateway reports
     * a terminal `OrderStatus` — deposited (`"2"`), refunded (`"4"`), or
     * reversed (`"3"`) — never for pending/pre-authorized/declined, so a
     * later callback can still re-verify. See {@link WebhookHandler.isTerminal}.
     */
    onMarkProcessed?: (orderId: string) => Promise<void> | void;

    /**
     * Max admitted callbacks per sliding window. Default 100. Counts all
     * orders on this handler instance, so size for peak throughput.
     * Callbacks over the limit reject as `rate_limited`; answering those
     * with `200` silently drops real payment notifications — surface via
     * {@link WebhookHandler.inspect} as 429/5xx.
     */
    maxCallbacksPerWindow?: number;
    /** Sliding window duration in ms. Default 60 000. */
    rateLimitWindowMs?: number;
    /**
     * Suppress the construction-time `console.warn` that fires when the
     * in-memory duplicate fallback is in use. Set to `true` only after
     * confirming single-process deployment.
     */
    suppressMultiInstanceWarning?: boolean;
}

/**
 * Zero-trust webhook handler.
 *
 * Construct via `satim.createWebhookHandler(options)`; do not instantiate
 * directly (the `satim` reference is required).
 *
 * The per-orderId in-flight lock serialises concurrent invocations for
 * the same orderId; different orderIds run in parallel.
 */
export class WebhookHandler {
    private readonly satim: Satim;
    private readonly onResolveAmount: WebhookHandlerOptions["onResolveAmount"];
    private readonly onCheckDuplicate: (orderId: string) => Promise<boolean> | boolean;
    private readonly onMarkProcessed: (orderId: string) => Promise<void> | void;
    private readonly rateLimiter: SlidingWindowRateLimiter;

    /** In-memory duplicate set used when no `onCheckDuplicate` is provided. */
    private readonly processedSet = new Set<string>();
    /**
     * Per-orderId Promise lock. Without it, two concurrent `verify()`
     * calls for the same orderId would both pass `onCheckDuplicate` and
     * both proceed to `confirm()`/`onMarkProcessed`, double-fulfilling
     * the order. The second call instead observes the first's result
     * with `duplicate: true`.
     */
    private readonly inflightLocks = new Map<string, Promise<WebhookResult | null>>();

    /**
     * Validates options and wires defaults.
     *
     * Warns via `console.warn` when both `onCheckDuplicate` and
     * `onMarkProcessed` are absent, unless `suppressMultiInstanceWarning`.
     *
     * @throws {@link SatimMissingDataError} if `onResolveAmount` is missing.
     * @throws {@link SatimInvalidArgumentError} if rate-limiter options
     *         are out of range or non-integer.
     */
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

    /**
     * Verify a webhook callback by re-fetching authoritative state:
     * extract orderId, rate-limit, dedupe, confirm/status, mark terminal
     * orders processed.
     *
     * @returns a `WebhookResult`, or `null` if the input was invalid,
     *          rate limited, or the order unknown — use {@link inspect}
     *          when those three need different HTTP responses.
     * @throws Anything `satim.confirm()` can throw; respond 500.
     */
    async verify(source: unknown): Promise<WebhookResult | null> {
        const outcome = await this.inspect(source);
        return outcome.verified ? outcome.result : null;
    }

    /**
     * Same flow as {@link verify}, but reports *why* verification did not
     * happen instead of collapsing every rejection to `null`.
     *
     * Use it to pick an HTTP status: 400 for junk, 429 for rate limiting
     * (so the gateway redelivers), 404 for an unknown order. The naive
     * `if (!result) return 200` shape drops real payments under load.
     *
     * @throws Anything `satim.confirm()` / `satim.status()` can throw.
     */
    async inspect(source: unknown): Promise<WebhookOutcome> {
        const orderId = extractOrderId(source);
        if (!orderId) return { verified: false, reason: "invalid_source" };
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

    /**
     * Core verification path, runs exactly once per `verify()` call.
     *
     * Holds the in-flight lock for its entire duration (the caller takes
     * the lock before `await`-ing this method).
     */
    private async executeVerify(orderId: string): Promise<WebhookResult | null> {
        // Independent DB lookups — run in parallel to save a round trip.
        const [isDuplicate, expectedAmount] = await Promise.all([
            this.onCheckDuplicate(orderId),
            this.onResolveAmount(orderId),
        ]);

        if (expectedAmount === undefined || expectedAmount === null) return null;

        // Replay path uses status(), not confirm(): confirm() calls the
        // mutating acknowledgeTransaction endpoint, which a replayed
        // callback must not re-fire. status() is idempotent and returns
        // the same live state.
        const response = isDuplicate
            ? await this.satim.status(orderId)
            : await this.satim.confirm(orderId, expectedAmount);

        // confirm() verifies the amount itself; status() does not, so the
        // replay path re-asserts it rather than trusting the earlier check.
        if (isDuplicate && response.isSuccessful()) response.verifyAmount(expectedAmount);

        if (!isDuplicate && WebhookHandler.isTerminal(response)) await this.onMarkProcessed(orderId);
        return { orderId, response, duplicate: isDuplicate };
    }

    /**
     * True only for states that can never advance again. Marking is
     * one-way — every later callback comes back `duplicate: true` — so a
     * looser "not pending" test breaks two cases: a pre-authorized hold
     * (`"1"`) would make the later capture (`"2"`) arrive as a
     * duplicate, and a declined/cancelled response (no `OrderStatus`)
     * would make a successful card retry arrive as a duplicate — either
     * way charged but never fulfilled.
     */
    private static isTerminal(response: ConfirmResponse): boolean {
        return response.isSuccessful() || response.isRefunded() || response.isReversed();
    }
}

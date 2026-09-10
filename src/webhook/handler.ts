/**
 * Zero-trust webhook handler for SATIM callbacks.
 *
 * The handler never trusts the callback payload. Every invocation
 * triggers a server-to-server `satim.confirm(orderId, expectedAmount)`
 * against the live gateway, with automatic amount verification via
 * `ConfirmResponse.verifyAmount`.
 *
 * # Why this is stronger than HMAC verification
 *
 * HMAC signatures prove the payload was issued by the gateway. They do
 * not prove the payload reflects current state. Replay attacks and
 * stale-webhook races pass signature checks because the signature is
 * still valid even though the state has moved on.
 *
 * Re-fetching live state defeats both: a replayed callback triggers a
 * fresh `confirm()` that returns the current state, and the amount check
 * against the merchant's source of truth prevents partial-payment
 * manipulation regardless of what the callback payload claims.
 *
 * # Built-in protections
 *
 * - **Rate limit** — sliding window cap on inbound callbacks.
 * - **In-flight lock** — per-orderId Promise lock prevents the
 *   check-then-mark race within a single process.
 * - **Duplicate detection** — pluggable persistence callbacks for
 *   multi-instance deployments.
 * - **Terminal-state marking** — only definitively finished orders
 *   (deposited, refunded, reversed) are marked processed, so callbacks
 *   for orders still in motion — pending, pre-authorized, declined —
 *   keep re-checking as the state advances.
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
 * - `invalid_source` — no syntactically valid orderId could be extracted.
 *   Respond `400`; redelivery will not help.
 * - `rate_limited` — the sliding window was full. Respond `429` (or any
 *   5xx) so the gateway redelivers; responding `200` silently drops a
 *   real payment notification.
 * - `unknown_order` — `onResolveAmount` returned `undefined`/`null`, so
 *   the order is not one this merchant issued. Respond `404`.
 */
export type WebhookRejectionReason = "invalid_source" | "rate_limited" | "unknown_order";

/**
 * Outcome of {@link WebhookHandler.inspect}: either a verified result or
 * the specific reason verification did not happen.
 *
 * `verify()` collapses this to `WebhookResult | null`, which cannot
 * distinguish "this callback is junk, drop it" from "I was too busy,
 * please resend". Prefer `inspect()` in any handler that returns an HTTP
 * status to the gateway.
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

export interface WebhookHandlerOptions {
    /**
     * Resolve the expected major-unit amount for an orderId. Typically
     * a database lookup keyed by the orderId your application stored at
     * registration time.
     *
     * Return `undefined` / `null` to reject the callback as referencing
     * an unknown order — `verify()` will return `null` without calling
     * the gateway.
     */
    onResolveAmount: (orderId: string) => Promise<number | undefined | null> | number | undefined | null;

    /**
     * Check whether `orderId` has already been processed.
     *
     * For multi-instance deployments, MUST implement check-and-mark as a
     * single atomic operation (Redis `SETNX`, database
     * `INSERT … ON CONFLICT DO NOTHING`). The handler's own in-flight
     * lock only serialises within a single Node.js process.
     *
     * Default (single-process only): in-memory `Set`.
     */
    onCheckDuplicate?: (orderId: string) => Promise<boolean> | boolean;

    /**
     * Mark `orderId` as processed.
     *
     * Called only once the gateway reports a **terminal** `OrderStatus`:
     * deposited (`"2"`), refunded (`"4"`), or reversed (`"3"`). Every
     * other state — pending, pre-authorized, declined, cancelled, expired
     * — leaves the order unmarked so a later callback can re-verify as it
     * advances. See {@link WebhookHandler.isTerminal} for why this is not
     * simply "not pending".
     */
    onMarkProcessed?: (orderId: string) => Promise<void> | void;

    /**
     * Max admitted callbacks per sliding window. Default 100.
     *
     * The limit is per handler instance and counts *all* orders, so size
     * it against peak checkout throughput, not against a single customer.
     * Callbacks over the limit are rejected with `rate_limited`; a handler
     * that answers those with `200` will silently lose payment
     * notifications, so surface them as `429`/5xx via {@link WebhookHandler.inspect}.
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
     * Per-orderId Promise lock. Prevents the check-then-mark race within
     * a single process: two concurrent `verify()` calls for the same
     * orderId would both pass `onCheckDuplicate` (returns `false`) and
     * both proceed to `confirm()` and `onMarkProcessed`, double-fulfilling
     * the order. The lock serialises them; the second call observes the
     * first's result with `duplicate: true`.
     */
    private readonly inflightLocks = new Map<string, Promise<WebhookResult | null>>();

    /**
     * Preconditions: `options.onResolveAmount` is provided.
     * `maxCallbacksPerWindow` (if set) is a positive integer.
     * `rateLimitWindowMs` (if set) is a positive integer ≥ 1000.
     *
     * Side effect: emits a `console.warn` when both `onCheckDuplicate`
     * and `onMarkProcessed` are absent (in-memory fallback) and
     * `suppressMultiInstanceWarning` is not set.
     *
     * @throws {@link SatimMissingDataError} when `onResolveAmount` is missing.
     * @throws {@link SatimInvalidArgumentError} when rate-limiter
     *         parameters are out of range or non-integer.
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
     * Verify a webhook callback by re-fetching authoritative state.
     *
     * Flow (each step short-circuits with `null` on failure):
     * 1. Extract orderId from `source` via {@link extractOrderId}.
     * 2. Apply rate limit.
     * 3. Acquire per-orderId in-flight lock.
     * 4. Run `onCheckDuplicate(orderId)`.
     * 5. Run `onResolveAmount(orderId)`. Unknown order → `null` (no gateway call).
     * 6. `satim.confirm(orderId, expectedAmount)` — or `satim.status()` when
     *    already processed. The amount is verified either way.
     * 7. `onMarkProcessed(orderId)` if the order reached a terminal state.
     * 8. Release lock in `finally`.
     *
     * Postcondition: returns a `WebhookResult` on success (including
     * duplicate detection), or `null` when input is invalid, rate
     * limited, or the order is unknown. Use {@link inspect} instead when
     * those three cases need different HTTP responses — they do.
     *
     * Complexity: dominated by the gateway round trip in step 6
     * (`O(network)`). All other steps are `O(1)` or `O(log n)` (rate
     * limiter).
     *
     * @throws Anything `satim.confirm()` can throw — primarily
     *         {@link SatimUnexpectedResponseError} on transport failures
     *         or amount mismatch. Callers should wrap the call and
     *         respond with HTTP 500 on unexpected throws.
     */
    async verify(source: unknown): Promise<WebhookResult | null> {
        const outcome = await this.inspect(source);
        return outcome.verified ? outcome.result : null;
    }

    /**
     * Same verification flow as {@link verify}, but reports *why* a
     * callback was not verified instead of collapsing every rejection to
     * `null`.
     *
     * Use this wherever the handler decides an HTTP status. The three
     * rejection reasons need three different answers to the gateway —
     * `400` for junk, `429` for rate limiting (so it redelivers), `404`
     * for an order this merchant never issued — and `verify()` cannot
     * tell them apart, so the usual `if (!result) return 200` shape drops
     * real payment notifications on the floor during a traffic spike.
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
        // Both are typically DB calls with no dependency on each other — run in parallel
        // to eliminate one sequential round trip before the gateway call.
        const [isDuplicate, expectedAmount] = await Promise.all([
            this.onCheckDuplicate(orderId),
            this.onResolveAmount(orderId),
        ]);

        if (expectedAmount === undefined || expectedAmount === null) return null;

        // An already-processed order is re-read with status() rather than
        // re-acknowledged with confirm(): both return authoritative live
        // state, but /public/acknowledgeTransaction.do is a mutating
        // acknowledgement, and replayed callbacks should not re-fire it.
        // status() is also idempotent, so it retries and de-duplicates.
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
     * True only for order states that can never advance again.
     *
     * Marking an order processed is irreversible from the handler's point
     * of view: every later callback for it comes back `duplicate: true`,
     * which callers are told not to fulfil. So the test has to be
     * "definitely finished", not "not pending" — two states break under
     * the looser test:
     *
     * - **Pre-authorized** (`OrderStatus` `"1"`) is a fund hold awaiting
     *   capture. Marking it means the later capture callback (`"2"`)
     *   arrives as a duplicate and the order is never fulfilled.
     * - **Declined / cancelled / expired** responses carry no
     *   `OrderStatus` at all. A customer who retries their card on the
     *   same order and succeeds produces a `"2"` callback that would
     *   likewise arrive as a duplicate — charged, unfulfilled.
     *
     * Leaving those unmarked costs at most a repeated `status()` read.
     */
    private static isTerminal(response: ConfirmResponse): boolean {
        return response.isSuccessful() || response.isRefunded() || response.isReversed();
    }
}

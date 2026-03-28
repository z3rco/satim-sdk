import type { Satim } from "./Satim";
import type { ConfirmResponse } from "./responses";
import { SatimInvalidArgumentError, SatimMissingDataError } from "./exceptions";

/**
 * Result of processing a webhook or callback from the SATIM gateway.
 *
 * Contains the **server-verified** payment status (fetched directly from
 * SATIM via `confirm()`), not the unverified callback payload.
 */
export interface WebhookResult {
    /** The order ID extracted from the callback. */
    orderId: string;
    /** Server-verified response from `confirm()`, with amount verification. */
    response: ConfirmResponse;
    /** True if this order ID was already processed (duplicate callback). */
    duplicate: boolean;
}

/**
 * Configuration for the webhook handler.
 */
export interface WebhookHandlerOptions {
    /**
     * Resolve the expected payment amount (in major units) for a given order ID.
     * This is your source of truth — typically a database lookup.
     *
     * Must return the same amount that was passed to `register()`.
     * Returning `undefined` or `null` rejects the callback as unknown.
     *
     * @param orderId - The order ID extracted from the callback.
     * @returns The expected amount in major units, or `undefined`/`null` to reject.
     */
    onResolveAmount: (orderId: string) => Promise<number | undefined | null> | number | undefined | null;

    /**
     * Check if an order ID has already been processed.
     * Prevents double-fulfillment from duplicate callbacks.
     *
     * Return `true` if the order was already fulfilled.
     * If not provided, the handler uses an in-memory Set
     * (suitable for single-process deployments only).
     *
     * **Important for distributed deployments:** Your implementation MUST
     * use an atomic check-and-mark strategy (e.g. Redis `SETNX`, database
     * `INSERT ... ON CONFLICT`) to prevent races across multiple instances.
     * The SDK's in-flight lock only protects within a single Node.js process.
     *
     * @param orderId - The order ID to check.
     * @returns `true` if already processed.
     */
    onCheckDuplicate?: (orderId: string) => Promise<boolean> | boolean;

    /**
     * Called after a successful (non-duplicate) verification.
     * Use this to mark the order as processed in your persistence layer.
     *
     * **Important for distributed deployments:** This is called separately
     * from `onCheckDuplicate`. To guarantee atomicity across multiple
     * processes, implement the duplicate check and mark as a single atomic
     * operation in `onCheckDuplicate` (return `false` AND mark in one step),
     * and use `onMarkProcessed` only for secondary bookkeeping.
     *
     * @param orderId - The order ID to mark as processed.
     */
    onMarkProcessed?: (orderId: string) => Promise<void> | void;

    /**
     * Maximum number of callbacks accepted within the rate limit window.
     * Protects against callback flooding attacks.
     *
     * @default 100
     */
    maxCallbacksPerWindow?: number;

    /**
     * Rate limit window duration in milliseconds.
     *
     * @default 60000 (1 minute)
     */
    rateLimitWindowMs?: number;

    /**
     * Suppress the multi-instance deduplication warning.
     *
     * By default, when neither `onCheckDuplicate` nor `onMarkProcessed` is
     * provided the handler emits a `console.warn` at construction time because
     * the in-memory fallback is **not safe across multiple processes** (k8s
     * pods, multiple dynos, serverless cold-starts).  If you have confirmed
     * that your deployment is single-process set this to `true` to silence it.
     *
     * @default false
     */
    suppressMultiInstanceWarning?: boolean;
}

// ─── Internal rate limiter ──────────────────────────────────────────────

class SlidingWindowRateLimiter {
    private timestamps: number[] = [];
    private head: number = 0;
    private readonly maxRequests: number;
    private readonly windowMs: number;

    constructor(maxRequests: number, windowMs: number) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
    }

    /**
     * Returns true if the request is allowed, false if rate limited.
     * Prunes expired timestamps on each check using a head pointer to
     * avoid O(n) array allocations.
     */
    check(): boolean {
        const now = Date.now();
        const cutoff = now - this.windowMs;

        // Binary search for the first timestamp within the window
        let lo = this.head;
        let hi = this.timestamps.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.timestamps[mid] <= cutoff) lo = mid + 1;
            else hi = mid;
        }
        this.head = lo;

        // Periodically compact the array to reclaim memory
        if (this.head > 1000) {
            this.timestamps = this.timestamps.slice(this.head);
            this.head = 0;
        }

        if (this.timestamps.length - this.head >= this.maxRequests) {
            return false;
        }

        this.timestamps.push(now);
        return true;
    }
}

// ─── Order ID extraction ────────────────────────────────────────────────

/** Strict orderId format: alphasatim-module + hyphens, 1–128 chars. */
const ORDER_ID_PATTERN = /^[a-zA-Z0-9\-]{1,128}$/;

/**
 * Extract and validate an orderId from an unknown source.
 * Returns the trimmed orderId or null if invalid.
 */
function extractOrderId(source: unknown): string | null {
    if (source === null || source === undefined) return null;

    let raw: string | undefined;

    // Case 1: String — could be a URL with ?orderId= or a plain orderId
    if (typeof source === "string") {
        const str = source.trim();
        // Check if it looks like a URL (contains :// or starts with ?)
        if (str.includes("://") || str.startsWith("?")) {
            try {
                const url = new URL(str, "http://localhost");
                raw = url.searchParams.get("orderId") ?? undefined;
            } catch {
                // Not a valid URL — treat as raw orderId
                raw = str;
            }
        } else {
            raw = str;
        }
    }

    // Case 2: Web API Request object (returnUrl redirect or webhook POST)
    if (!raw && typeof source === "object" && source !== null && "url" in source) {
        try {
            const req = source as { url?: string; method?: string; text?: () => Promise<string> };
            if (typeof req.url === "string") {
                const url = new URL(req.url, "http://localhost");
                raw = url.searchParams.get("orderId") ?? undefined;
            }
        } catch {
            // Not a valid URL — fall through
        }
    }

    // Case 3: Plain object with orderId property (parsed JSON body, query object)
    if (!raw && typeof source === "object" && source !== null) {
        const obj = source as Record<string, unknown>;
        if (typeof obj.orderId === "string") {
            raw = obj.orderId;
        } else if (typeof obj.orderId === "number") {
            raw = String(obj.orderId);
        }
    }

    if (!raw) return null;

    const trimmed = raw.trim();
    if (!trimmed || !ORDER_ID_PATTERN.test(trimmed)) return null;

    return trimmed;
}

/**
 * Zero-trust webhook and callback handler for the SATIM payment gateway.
 *
 * Unlike signature-based verification (e.g. HMAC), this handler **never
 * trusts the callback payload**. Every callback triggers a server-to-server
 * `confirm()` call to the SATIM gateway, with automatic amount verification.
 *
 * This is strictly stronger than signature-based verification because:
 * - A valid signature proves the payload was sent by the gateway, but NOT
 *   that it represents the current state (replay attacks, race conditions).
 * - Our approach fetches the **live authoritative state** from SATIM on
 *   every callback, so even a perfectly forged or replayed callback only
 *   triggers a fresh server-to-server check.
 *
 * Built-in protections:
 * - **Replay/duplicate rejection** — tracked via pluggable persistence
 * - **Rate limiting** — sliding window to prevent callback flooding
 * - **Amount verification** — automatic on successful payments
 * - **Payload sanitization** — orderId validated before any gateway call
 * - **Zero payload trust** — callback body is used only to extract the orderId
 *
 * @name WebhookHandler
 * @see Satim.createWebhookHandler
 */
export class WebhookHandler {
    private readonly satim: Satim;
    private readonly onResolveAmount: WebhookHandlerOptions["onResolveAmount"];
    private readonly onCheckDuplicate: (orderId: string) => Promise<boolean> | boolean;
    private readonly onMarkProcessed: (orderId: string) => Promise<void> | void;
    private readonly rateLimiter: SlidingWindowRateLimiter;

    /** In-memory fallback for duplicate tracking (single-process only). */
    private readonly processedSet = new Set<string>();

    /**
     * Per-orderId in-flight lock. Prevents the race condition where two
     * concurrent `verify()` calls for the same orderId both pass the
     * duplicate check before either marks processed — causing double-fulfillment.
     *
     * Key: orderId, Value: Promise of the in-flight verification.
     * Cleared when the verification completes (success or failure).
     */
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

        // Duplicate tracking — pluggable or in-memory fallback
        const usingInMemoryFallback = !options.onCheckDuplicate && !options.onMarkProcessed;
        if (usingInMemoryFallback && !options.suppressMultiInstanceWarning) {
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
            ?? ((orderId: string) => this.processedSet.has(orderId));
        this.onMarkProcessed = options.onMarkProcessed
            ?? ((orderId: string) => { this.processedSet.add(orderId); });

        // Rate limiter
        const maxCallbacks = options.maxCallbacksPerWindow ?? 100;
        const windowMs = options.rateLimitWindowMs ?? 60_000;
        if (maxCallbacks < 1 || !Number.isInteger(maxCallbacks)) {
            throw new SatimInvalidArgumentError("maxCallbacksPerWindow must be a positive integer.");
        }
        if (windowMs < 1000 || !Number.isInteger(windowMs)) {
            throw new SatimInvalidArgumentError("rateLimitWindowMs must be an integer >= 1000.");
        }
        this.rateLimiter = new SlidingWindowRateLimiter(maxCallbacks, windowMs);
    }

    /**
     * Process and verify a SATIM callback or redirect.
     *
     * Accepts any of:
     * - A string orderId
     * - A URL string (e.g. `"https://your-app.com/success?orderId=abc123"`)
     * - A Web API Request object
     * - A plain object with an `orderId` property (parsed JSON body, query params)
     *
     * **What happens internally:**
     * 1. Extracts and validates the orderId from the input
     * 2. Checks rate limits (rejects if flooded)
     * 3. Checks for duplicate processing (returns `{ duplicate: true }` if seen)
     * 4. Looks up the expected amount via `onResolveAmount` (rejects if unknown)
     * 5. Calls `satim.confirm(orderId, expectedAmount)` server-to-server
     * 6. Marks the order as processed via `onMarkProcessed`
     * 7. Returns the verified `ConfirmResponse` with full status predicates
     *
     * @param source - The callback payload, URL, request, or orderId string.
     * @returns WebhookResult on success, `null` if the orderId is missing/invalid/unknown
     *          or rate limited.
     * @throws SatimUnexpectedResponseError if the SATIM gateway returns an unexpected response.
     * @throws SatimInvalidCredentialsError if credentials are rejected.
     */
    async verify(source: unknown): Promise<WebhookResult | null> {
        // Step 1: Extract orderId — reject garbage early
        const orderId = extractOrderId(source);
        if (!orderId) return null;

        // Step 2: Rate limit — prevent callback flooding
        if (!this.rateLimiter.check()) return null;

        // Step 3: Serialize concurrent calls for the same orderId.
        // Without this, two concurrent verify() calls can both pass
        // the duplicate check before either marks processed — causing
        // double-fulfillment. The lock ensures only one call proceeds
        // at a time per orderId.
        const inflight = this.inflightLocks.get(orderId);
        if (inflight) {
            const firstResult = await inflight.catch(() => null);
            if (!firstResult) return null;
            return { orderId, response: firstResult.response, duplicate: true };
        }

        // Acquire the lock for this orderId
        const execution = this.executeVerify(orderId);
        this.inflightLocks.set(orderId, execution);

        try {
            return await execution;
        } finally {
            this.inflightLocks.delete(orderId);
        }
    }

    /**
     * Core verification logic, called only once per orderId at a time.
     * The caller (verify) holds the in-flight lock.
     */
    private async executeVerify(orderId: string): Promise<WebhookResult | null> {
        // Step 4: Duplicate check — prevent double-fulfillment
        const isDuplicate = await this.onCheckDuplicate(orderId);
        if (isDuplicate) {
            const amount = await this.onResolveAmount(orderId);
            if (amount === undefined || amount === null) return null;
            const response = await this.satim.confirm(orderId, amount);
            return { orderId, response, duplicate: true };
        }

        // Step 5: Resolve expected amount — reject unknown orders
        const expectedAmount = await this.onResolveAmount(orderId);
        if (expectedAmount === undefined || expectedAmount === null) return null;

        // Step 6: Server-to-server verification — the actual source of truth
        const response = await this.satim.confirm(orderId, expectedAmount);

        // Step 7: Mark as processed (only for terminal states)
        if (!response.isPending()) {
            await this.onMarkProcessed(orderId);
        }

        // Step 8: Return verified result
        return { orderId, response, duplicate: false };
    }
}

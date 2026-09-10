/**
 * Sliding-window rate limiter with binary-search expiry pruning.
 *
 * Stores arrival timestamps in a sorted array and advances a `head`
 * pointer past expired entries via binary search instead of
 * `Array.shift()`, compacting once `head` crosses 1000.
 * @file
 */

/**
 * Tracks request arrival timestamps in a sliding window of fixed duration.
 *
 * Safe without locks: JavaScript's single-threaded execution means only
 * one `check()` runs at a time, and `check()` contains no `await`.
 */
export class SlidingWindowRateLimiter {
    private timestamps: number[] = [];
    private head = 0;
    private readonly maxRequests: number;
    private readonly windowMs: number;

    /**
     * Preconditions: `maxRequests` is a positive integer; `windowMs` is
     * a positive integer ≥ 1000. Caller (`WebhookHandler`) validates
     * these — this class trusts its inputs.
     */
    constructor(maxRequests: number, windowMs: number) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
    }

    /**
     * Admit or reject the current request, pruning expired entries first.
     *
     * @returns `true` if the request is admitted, `false` if rate limited.
     */
    check(): boolean {
        const now = Date.now();
        const cutoff = now - this.windowMs;

        let lo = this.head;
        let hi = this.timestamps.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.timestamps[mid] <= cutoff) lo = mid + 1;
            else hi = mid;
        }
        this.head = lo;

        if (this.head > 1000) {
            this.timestamps = this.timestamps.slice(this.head);
            this.head = 0;
        }

        if (this.timestamps.length - this.head >= this.maxRequests) return false;
        this.timestamps.push(now);
        return true;
    }
}

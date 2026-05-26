/**
 * Sliding-window rate limiter with binary-search expiry pruning.
 *
 * Stores arrival timestamps in a sorted array. On each `check()`, advances
 * a `head` pointer past expired entries using binary search (`O(log n)`)
 * instead of `Array.shift()` (`O(n)`). The array is periodically compacted
 * once the head crosses 1000 entries, amortising the `slice` cost.
 * @file
 */

/**
 * Tracks request arrival timestamps in a sliding window of fixed duration.
 *
 * Not thread-safe across event-loop ticks: a `check()` call observes the
 * current state and may add to the array. Concurrent calls from different
 * async contexts could in principle race, but in practice JavaScript's
 * single-threaded execution means only one `check()` runs at a time per
 * process — the race is impossible without explicit `await` interleaving
 * inside `check()` (which there isn't).
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
     * Admit or reject the current request.
     *
     * Side effects: prunes the head pointer past expired entries;
     * compacts the array when `head > 1000`; appends `now` on admission.
     *
     * Postcondition on `true`: `timestamps.length - head` strictly
     * increased by 1.
     *
     * Postcondition on `false`: state unchanged (no append).
     *
     * Complexity: O(log n) per call for binary search, where n is the
     * unexpired timestamp count. Compaction is `O(n)` but amortised to
     * `O(1)` per call by the 1000-entry threshold.
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

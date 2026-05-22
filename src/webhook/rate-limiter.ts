/**
 * Sliding-window rate limiter with binary-search expiry pruning.
 * Avoids per-check array allocations via a head pointer + periodic compaction.
 * @file
 */

/** Tracks request timestamps in a sliding window. */
export class SlidingWindowRateLimiter {
    private timestamps: number[] = [];
    private head = 0;
    private readonly maxRequests: number;
    private readonly windowMs: number;

    constructor(maxRequests: number, windowMs: number) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
    }

    /** @returns true if the request is allowed, false if rate limited. */
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

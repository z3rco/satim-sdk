/**
 * Failure-counting circuit breaker with single-probe `HALF_OPEN` recovery.
 *
 * Sits in front of `HttpClientService.sendRequest`. When the gateway is
 * degraded, the breaker fails the SDK's calls fast instead of letting them
 * stack up on timeouts, and admits exactly one probe request after the
 * reset timeout to test recovery.
 *
 * State machine:
 *
 *     CLOSED ──(failureThreshold consecutive transient failures)──▶ OPEN
 *     OPEN   ──(resetTimeoutMs elapsed, next allowRequest())──────▶ HALF_OPEN
 *     HALF_OPEN ──(probe succeeds)──▶ CLOSED
 *     HALF_OPEN ──(probe fails)─────▶ OPEN (reset timer restarted)
 *
 * In `HALF_OPEN` only one in-flight probe is permitted; concurrent calls
 * receive `false` from `allowRequest()` until the probe resolves. This
 * prevents a recovering gateway from being hit by a thundering herd.
 *
 * All methods are O(1).
 * @file
 */

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
    /** Consecutive transient failures before opening. Default 5. */
    failureThreshold?: number;
    /** `OPEN` duration before a `HALF_OPEN` probe is admitted. Default 30 000 ms. */
    resetTimeoutMs?: number;
}

/**
 * Tracks transient failures and gates requests during gateway degradation.
 *
 * Instances are not shared across processes — state is in-memory only.
 * In multi-process deployments each process maintains its own breaker;
 * a degraded gateway affects all processes simultaneously, so independent
 * breakers converge quickly.
 */
export class CircuitBreaker {
    private state: CircuitState = "CLOSED";
    private consecutiveFailures = 0;
    private openedAt: number | null = null;
    private probeInFlight = false;
    private readonly failureThreshold: number;
    private readonly resetTimeoutMs: number;

    constructor(opts?: CircuitBreakerOptions) {
        this.failureThreshold = opts?.failureThreshold ?? 5;
        this.resetTimeoutMs = opts?.resetTimeoutMs ?? 30_000;
    }

    /**
     * Decide whether the caller may dispatch a request.
     *
     * Mutates state on `OPEN → HALF_OPEN` transition when the reset
     * timeout has elapsed. In `HALF_OPEN`, admits at most one concurrent probe.
     *
     * Callers MUST follow a `true` return with exactly one call to
     * {@link onSuccess} or {@link onFailure} after the request resolves.
     */
    allowRequest(): boolean {
        if (this.state === "CLOSED") return true;
        if (this.state === "OPEN") {
            if (this.openedAt !== null && Date.now() - this.openedAt >= this.resetTimeoutMs) {
                this.state = "HALF_OPEN";
                this.probeInFlight = true;
                return true;
            }
            return false;
        }
        if (this.probeInFlight) return false;
        this.probeInFlight = true;
        return true;
    }

    /** Reset to `CLOSED` and clear counters. */
    onSuccess(): void {
        this.consecutiveFailures = 0;
        this.openedAt = null;
        this.probeInFlight = false;
        this.state = "CLOSED";
    }

    /**
     * Record a transient failure. Transitions:
     * - `HALF_OPEN` → `OPEN` immediately (probe failed; restart reset timer).
     * - `CLOSED` → `OPEN` once `consecutiveFailures >= failureThreshold`.
     * - `OPEN` → `OPEN` (counter still increments for diagnostics).
     */
    onFailure(): void {
        this.consecutiveFailures++;
        this.probeInFlight = false;
        if (this.state === "HALF_OPEN" || this.consecutiveFailures >= this.failureThreshold) {
            this.state = "OPEN";
            this.openedAt = Date.now();
        }
    }

    /**
     * Report effective state. An `OPEN` breaker whose reset timeout has
     * elapsed is reported as `HALF_OPEN` even before `allowRequest()`
     * performs the transition — useful for monitoring without driving traffic.
     */
    getState(): CircuitState {
        if (
            this.state === "OPEN" &&
            this.openedAt !== null &&
            Date.now() - this.openedAt >= this.resetTimeoutMs
        ) return "HALF_OPEN";
        return this.state;
    }

    getConsecutiveFailures(): number {
        return this.consecutiveFailures;
    }
}

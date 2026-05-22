/**
 * Failure-counting circuit breaker with HALF_OPEN single-probe recovery.
 *
 * States: CLOSED → OPEN (on threshold) → HALF_OPEN (after reset timeout)
 *                                      → CLOSED (probe success) or OPEN (probe fail).
 * @file
 */

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
    /** Consecutive transient failures before opening. Default 5. */
    failureThreshold?: number;
    /** OPEN duration before HALF_OPEN probe is allowed. Default 30000 ms. */
    resetTimeoutMs?: number;
}

/** Tracks transient failures and gates requests during gateway degradation. */
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
     * @returns true if the request may proceed. Mutates state on OPEN→HALF_OPEN.
     *          In HALF_OPEN only one probe is admitted concurrently.
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

    /** Reset on success — clears counters and closes the circuit. */
    onSuccess(): void {
        this.consecutiveFailures = 0;
        this.openedAt = null;
        this.probeInFlight = false;
        this.state = "CLOSED";
    }

    /** Record a transient failure; opens the circuit at threshold or on HALF_OPEN failure. */
    onFailure(): void {
        this.consecutiveFailures++;
        this.probeInFlight = false;
        if (this.state === "HALF_OPEN" || this.consecutiveFailures >= this.failureThreshold) {
            this.state = "OPEN";
            this.openedAt = Date.now();
        }
    }

    /** Returns effective state, reflecting a timed-out OPEN as HALF_OPEN. */
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

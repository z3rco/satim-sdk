/**
 * Failure-counting circuit breaker with single-probe `HALF_OPEN` recovery.
 *
 * CLOSED → OPEN after `failureThreshold` consecutive failures. OPEN →
 * HALF_OPEN after `resetTimeoutMs`, admitting exactly one probe; success
 * → CLOSED, failure → OPEN. Only one probe is in flight at a time, so a
 * recovering gateway isn't hit by a thundering herd.
 * @file
 */

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Tuning for {@link CircuitBreaker}. Pass `false` as `circuitBreaker` to disable it entirely. */
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
    /** Wall-clock time the current `HALF_OPEN` probe was admitted, for abandonment detection. */
    private probeStartedAt: number | null = null;
    private readonly failureThreshold: number;
    private readonly resetTimeoutMs: number;

    constructor(opts?: CircuitBreakerOptions) {
        this.failureThreshold = opts?.failureThreshold ?? 5;
        this.resetTimeoutMs = opts?.resetTimeoutMs ?? 30_000;
    }

    /**
     * Decide whether the caller may dispatch a request. On `true`, the
     * caller MUST call {@link onSuccess} or {@link onFailure} once the
     * request resolves.
     *
     * A probe left unreported for `resetTimeoutMs` is treated as
     * abandoned and a fresh one is admitted — otherwise `probeInFlight`
     * (cleared only by onSuccess/onFailure) would stay set forever and
     * the breaker would reject every request for the life of the process.
     */
    allowRequest(): boolean {
        if (this.state === "CLOSED") return true;
        if (this.state === "OPEN") {
            if (this.openedAt !== null && Date.now() - this.openedAt >= this.resetTimeoutMs) {
                this.startProbe();
                return true;
            }
            return false;
        }
        if (this.probeInFlight && !this.isProbeAbandoned()) return false;
        this.startProbe();
        return true;
    }

    /** Reset to `CLOSED` and clear counters. */
    onSuccess(): void {
        this.consecutiveFailures = 0;
        this.openedAt = null;
        this.endProbe();
        this.state = "CLOSED";
    }

    /** Enter `HALF_OPEN` with a single admitted probe. */
    private startProbe(): void {
        this.state = "HALF_OPEN";
        this.probeInFlight = true;
        this.probeStartedAt = Date.now();
    }

    /** Clear probe bookkeeping once a probe's outcome has been reported. */
    private endProbe(): void {
        this.probeInFlight = false;
        this.probeStartedAt = null;
    }

    /**
     * True when the in-flight probe has gone unreported for at least
     * `resetTimeoutMs` — the caller crashed, threw past its accounting, or
     * otherwise never reported an outcome.
     */
    private isProbeAbandoned(): boolean {
        return this.probeStartedAt !== null
            && Date.now() - this.probeStartedAt >= this.resetTimeoutMs;
    }

    /**
     * Record a transient failure. Transitions:
     * - `HALF_OPEN` → `OPEN` immediately (probe failed; restart reset timer).
     * - `CLOSED` → `OPEN` once `consecutiveFailures >= failureThreshold`.
     * - `OPEN` → `OPEN` (counter still increments for diagnostics).
     */
    onFailure(): void {
        this.consecutiveFailures++;
        this.endProbe();
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

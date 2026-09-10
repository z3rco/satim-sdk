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
    /** Wall-clock time the current `HALF_OPEN` probe was admitted, for abandonment detection. */
    private probeStartedAt: number | null = null;
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
     * Callers SHOULD follow a `true` return with exactly one call to
     * {@link onSuccess} or {@link onFailure} after the request resolves.
     * A caller that fails to do so cannot strand the breaker: a probe
     * still unreported after `resetTimeoutMs` is treated as abandoned and
     * a fresh probe is admitted. Without that guard a single unreported
     * probe would leave `probeInFlight` set forever and the breaker would
     * reject every subsequent request for the life of the process, with
     * no timer able to recover it.
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

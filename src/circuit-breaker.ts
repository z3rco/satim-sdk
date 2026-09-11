type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {

    failureThreshold?: number;

    resetTimeoutMs?: number;
}

export class CircuitBreaker {
    private state: CircuitState = "CLOSED";
    private consecutiveFailures = 0;
    private openedAt: number | null = null;
    private probeInFlight = false;

    private probeStartedAt: number | null = null;
    private readonly failureThreshold: number;
    private readonly resetTimeoutMs: number;

    constructor(opts?: CircuitBreakerOptions) {
        this.failureThreshold = opts?.failureThreshold ?? 5;
        this.resetTimeoutMs = opts?.resetTimeoutMs ?? 30_000;
    }

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

    onSuccess(): void {
        this.consecutiveFailures = 0;
        this.openedAt = null;
        this.endProbe();
        this.state = "CLOSED";
    }

    private startProbe(): void {
        this.state = "HALF_OPEN";
        this.probeInFlight = true;
        this.probeStartedAt = Date.now();
    }

    private endProbe(): void {
        this.probeInFlight = false;
        this.probeStartedAt = null;
    }

    private isProbeAbandoned(): boolean {
        return this.probeStartedAt !== null
            && Date.now() - this.probeStartedAt >= this.resetTimeoutMs;
    }

    onFailure(): void {
        this.consecutiveFailures++;
        this.endProbe();
        if (this.state === "HALF_OPEN" || this.consecutiveFailures >= this.failureThreshold) {
            this.state = "OPEN";
            this.openedAt = Date.now();
        }
    }

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

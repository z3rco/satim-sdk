import { SatimInvalidArgumentError } from './exceptions.js';

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {

    failureThreshold?: number;

    resetTimeoutMs?: number;

    probeTimeoutMs?: number;
}

export class CircuitBreaker {
    private state: CircuitState = "CLOSED";
    private consecutiveFailures = 0;
    private openedAt: number | null = null;
    private probeInFlight = false;

    // Cleared only by onSuccess/onFailure; the abandonment check below stops one unreported probe wedging the breaker forever.
    private probeStartedAt: number | null = null;
    private readonly failureThreshold: number;
    private readonly resetTimeoutMs: number;
    private readonly probeTimeoutMs: number;

    constructor(opts?: CircuitBreakerOptions) {
        const failureThreshold = opts?.failureThreshold ?? 5;
        const resetTimeoutMs = opts?.resetTimeoutMs ?? 30_000;
        const probeTimeoutMs = opts?.probeTimeoutMs ?? resetTimeoutMs;
        if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
            throw new SatimInvalidArgumentError("CircuitBreaker: failureThreshold must be a positive integer.");
        }
        if (!Number.isFinite(resetTimeoutMs) || resetTimeoutMs < 0) {
            throw new SatimInvalidArgumentError("CircuitBreaker: resetTimeoutMs must be a finite number >= 0.");
        }
        if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs < 0) {
            throw new SatimInvalidArgumentError("CircuitBreaker: probeTimeoutMs must be a finite number >= 0.");
        }
        this.failureThreshold = failureThreshold;
        this.resetTimeoutMs = resetTimeoutMs;
        this.probeTimeoutMs = probeTimeoutMs;
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
        // Admit a fresh probe if the last was never reported (caller crashed mid-probe).
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
            && Date.now() - this.probeStartedAt >= this.probeTimeoutMs;
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

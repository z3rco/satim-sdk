import {
    SatimError,
    SatimInvalidCredentialsError,
    SatimUnexpectedResponseError,
    SatimInvalidArgumentError,
    SatimGatewayError,
} from "./exceptions";

/**
 * Sanitize gateway error messages to prevent leaking internal details.
 * Truncates to 200 characters and strips non-printable characters.
 */
function sanitizeGatewayMessage(message: string): string {
    return message.replace(/[^\x20-\x7E]/g, "").slice(0, 200);
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

/**
 * Circuit breaker states:
 * - CLOSED:    Normal operation; requests flow through.
 * - OPEN:      Failure threshold exceeded; requests fail immediately.
 * - HALF_OPEN: Recovery probe — one request is allowed through to test the gateway.
 */
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/**
 * Options for configuring the circuit breaker.
 */
export interface CircuitBreakerOptions {
    /**
     * Number of consecutive transient failures before the circuit opens.
     * @default 5
     */
    failureThreshold?: number;
    /**
     * How long (ms) to wait in OPEN state before attempting a recovery probe.
     * @default 30000 (30 seconds)
     */
    resetTimeoutMs?: number;
}

/**
 * Lightweight circuit breaker that tracks consecutive transient failures
 * (5xx responses and timeouts) and opens the circuit when the failure
 * threshold is exceeded.  Automatically transitions to HALF_OPEN after
 * the reset timeout so the gateway can be re-probed without operator
 * intervention.
 *
 * - CLOSED  → normal operation
 * - OPEN    → fail-fast; throws SatimUnexpectedResponseError immediately
 * - HALF_OPEN → one probe request allowed through; success closes the
 *               circuit, failure re-opens it with a fresh reset timer
 */
class CircuitBreaker {
    private state: CircuitState = "CLOSED";
    private consecutiveFailures = 0;
    private openedAt: number | null = null;
    private probeInFlight = false;

    private readonly failureThreshold: number;
    private readonly resetTimeoutMs: number;

    constructor(options?: CircuitBreakerOptions) {
        this.failureThreshold = options?.failureThreshold ?? 5;
        this.resetTimeoutMs = options?.resetTimeoutMs ?? 30_000;
    }

    /**
     * Returns true if the circuit is allowing a request through.
     * Automatically transitions OPEN → HALF_OPEN when the reset timeout elapses.
     * In HALF_OPEN state, only a single probe request is allowed through at a time.
     */
    allowRequest(): boolean {
        if (this.state === "CLOSED") return true;

        if (this.state === "OPEN") {
            if (this.openedAt !== null && Date.now() - this.openedAt >= this.resetTimeoutMs) {
                this.state = "HALF_OPEN";
                this.probeInFlight = true;
                return true; // allow the probe
            }
            return false;
        }

        // HALF_OPEN: only one probe request at a time
        if (this.probeInFlight) return false;
        this.probeInFlight = true;
        return true;
    }

    /** Call after a successful request to reset the breaker. */
    onSuccess(): void {
        this.consecutiveFailures = 0;
        this.openedAt = null;
        this.probeInFlight = false;
        this.state = "CLOSED";
    }

    /** Call after a transient failure. Opens the circuit when threshold is reached. */
    onFailure(): void {
        this.consecutiveFailures++;
        this.probeInFlight = false;
        if (this.state === "HALF_OPEN" || this.consecutiveFailures >= this.failureThreshold) {
            this.state = "OPEN";
            this.openedAt = Date.now();
        }
    }

    getState(): CircuitState {
        // Reflect a timed-out OPEN as HALF_OPEN for external inspection
        if (
            this.state === "OPEN" &&
            this.openedAt !== null &&
            Date.now() - this.openedAt >= this.resetTimeoutMs
        ) {
            return "HALF_OPEN";
        }
        return this.state;
    }

    getConsecutiveFailures(): number {
        return this.consecutiveFailures;
    }
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

/**
 * Options accepted by {@link HttpClientService}.
 */
export interface HttpClientOptions {
    /**
     * Maximum number of retries on transient errors (5xx, timeouts).
     * @default 2
     * @range 0–10
     */
    maxRetries?: number;
    /**
     * Per-request timeout in milliseconds.
     * Increase for high-latency environments or decrease for faster fail-over.
     * @default 30000 (30 seconds)
     */
    timeoutMs?: number;
    /**
     * Circuit breaker configuration.
     * Set to `false` to disable the circuit breaker entirely.
     */
    circuitBreaker?: CircuitBreakerOptions | false;
}

/**
 * Low-level HTTP transport for the SATIM REST API.
 *
 * Sends `application/x-www-form-urlencoded` POST requests to either the
 * production (`cib.satim.dz`) or test (`test.satim.dz`) gateway and returns
 * the parsed JSON response.  Validation of gateway-level error codes
 * (ErrorCode 5 = Access Denied, ErrorCode 6 = Unknown Order) is handled
 */
export class HttpClientService {
    private readonly API_URL = "https://cib.satim.dz/payment/rest";
    private readonly TEST_API_URL = "https://test2.satim.dz/payment/rest";
    private static readonly DEFAULT_TIMEOUT_MS = 30_000;
    private static readonly DEFAULT_MAX_RETRIES = 2;
    private static readonly BASE_RETRY_DELAY_MS = 500;

    private readonly maxRetries: number;
    private readonly timeoutMs: number;
    private readonly circuitBreaker: CircuitBreaker | null;

    /**
     * @param testMode - When true, requests are routed to the SATIM sandbox.
     * @param options  - Optional configuration for retries, timeout, and circuit breaker.
     */
    constructor(
        private readonly testMode: boolean = false,
        options?: HttpClientOptions,
    ) {
        const maxRetries = options?.maxRetries ?? HttpClientService.DEFAULT_MAX_RETRIES;
        this.maxRetries = Math.min(10, Math.max(0, Math.floor(maxRetries)));

        const timeoutMs = options?.timeoutMs ?? HttpClientService.DEFAULT_TIMEOUT_MS;
        if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
            throw new SatimInvalidArgumentError("timeoutMs must be a number between 1000 and 300000 ms.");
        }
        this.timeoutMs = timeoutMs;

        if (options?.circuitBreaker === false) {
            this.circuitBreaker = null;
        } else {
            this.circuitBreaker = new CircuitBreaker(options?.circuitBreaker);
        }
    }

    private getApiUrl(): string {
        return this.testMode ? this.TEST_API_URL : this.API_URL;
    }

    /**
     * Send a request to a SATIM endpoint and validate the response.
     *
     * @param endpoint - REST path (e.g. "/register.do").
     * @param data     - Key/value pairs to send as form-encoded body.
     * @returns Parsed JSON response from the gateway.
     *
     * @throws SatimInvalidCredentialsError on ErrorCode 5 (Access Denied).
     * @throws SatimInvalidArgumentError    on ErrorCode 6 (Unknown Order).
     * @throws SatimGatewayError            on ErrorCode 1 (Duplicate Order), 3 (Unknown Currency),
     *                                      4 (Missing Parameter), or 7 (System Error).
     * @throws SatimUnexpectedResponseError on network failures or non-JSON responses.
     * @throws SatimUnexpectedResponseError with errorCategory "circuit_open" when the circuit breaker is open.
     */
    public async handleApiRequest<T = unknown>(
        endpoint: string,
        data: Record<string, unknown>,
        options?: { retryable?: boolean },
    ): Promise<T> {
        const result = await this.sendRequest<T>(endpoint, data, options?.retryable ?? true);
        this.validateApiResponse(result);
        return result;
    }

    /**
     * Calculate retry delay with exponential backoff and jitter.
     */
    private getRetryDelay(attempt: number): number {
        const exponentialDelay = HttpClientService.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        const jitter = Math.random() * exponentialDelay * 0.5;
        return exponentialDelay + jitter;
    }

    /**
     * Determine if an error is transient and eligible for retry.
     */
    private isRetryableError(error: unknown): boolean {
        if (error instanceof SatimUnexpectedResponseError) {
            return error.isTimeout || (error.httpStatus !== undefined && error.httpStatus >= 500);
        }
        return false;
    }

    /**
     * Perform the raw HTTP POST and parse the response body as JSON.
     * Retries transient errors (5xx, timeouts) with exponential backoff.
     * Fails fast when the circuit breaker is open.
     */
    private assertTlsSafe(): void {
        if (typeof process !== "undefined" && process.env?.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
            throw new SatimError(
                "NODE_TLS_REJECT_UNAUTHORIZED=0 detected. " +
                "Refusing to send payment credentials over an unverified TLS connection.",
            );
        }
    }

    private async sendRequest<T>(endpoint: string, data: Record<string, unknown>, retryable: boolean = true): Promise<T> {
        // Circuit breaker: fail fast if the circuit is open
        if (this.circuitBreaker && !this.circuitBreaker.allowRequest()) {
            throw new SatimUnexpectedResponseError(
                `Circuit breaker is open after ${this.circuitBreaker.getConsecutiveFailures()} consecutive failures. ` +
                `Requests to the SATIM gateway are temporarily suspended.`,
                "circuit_open",
            );
        }

        const url = `${this.getApiUrl()}${endpoint}`;

        const formBody = new URLSearchParams();
        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined && value !== null) {
                formBody.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
            }
        }

        const effectiveMaxRetries = retryable ? this.maxRetries : 0;
        let lastError: unknown;
        for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
            let circuitFailureCounted = false;
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, this.getRetryDelay(attempt - 1)));
            }

            this.assertTlsSafe();

            const controller = new AbortController();
            const timeoutId = setTimeout(
                () => controller.abort(),
                this.timeoutMs,
            );

            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Cache-Control": "no-store, no-cache",
                        "Pragma": "no-cache",
                    },
                    body: formBody.toString(),
                    signal: controller.signal,
                });

                if (!response.ok) {
                    const httpError = new SatimUnexpectedResponseError(
                        `HTTP Error: ${response.status} ${response.statusText}`,
                        "http",
                        undefined,
                        { httpStatus: response.status },
                    );
                    if (response.status >= 500 && attempt < effectiveMaxRetries) {
                        this.circuitBreaker?.onFailure();
                        circuitFailureCounted = true;
                        lastError = httpError;
                        continue;
                    }
                    if (response.status >= 500) {
                        this.circuitBreaker?.onFailure();
                        circuitFailureCounted = true;
                    }
                    throw httpError;
                }

                const text = await response.text();
                let responseData: T;
                try {
                    responseData = JSON.parse(text) as T;
                } catch (err) {
                    throw new SatimUnexpectedResponseError("Invalid JSON from API", "parse");
                }

                if (responseData === null || typeof responseData !== "object") {
                    throw new SatimUnexpectedResponseError(
                        "API returned a non-object response",
                    );
                }

                // Success — reset the circuit breaker
                this.circuitBreaker?.onSuccess();
                return responseData;
            } catch (error) {
                if (error instanceof SatimUnexpectedResponseError) {
                    // Avoid double-counting: only call onFailure() here if the
                    // !response.ok block above has not already counted this attempt.
                    if (!circuitFailureCounted && this.isRetryableError(error)) {
                        if (attempt < effectiveMaxRetries) {
                            this.circuitBreaker?.onFailure();
                            circuitFailureCounted = true;
                            lastError = error;
                            continue;
                        }
                        this.circuitBreaker?.onFailure();
                    }
                    throw error;
                }
                if (error instanceof DOMException && error.name === "AbortError") {
                    const timeoutError = new SatimUnexpectedResponseError(
                        `Request timed out after ${this.timeoutMs}ms`,
                        "timeout",
                        undefined,
                        { isTimeout: true },
                    );
                    if (attempt < effectiveMaxRetries) {
                        this.circuitBreaker?.onFailure();
                        lastError = timeoutError;
                        continue;
                    }
                    this.circuitBreaker?.onFailure();
                    throw timeoutError;
                }
                throw new SatimUnexpectedResponseError("Network or internal error", "network");
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw lastError ?? new SatimUnexpectedResponseError("Request failed after retries");
    }

    /**
     * Inspect the parsed response for well-known gateway error codes and
     * throw typed errors so callers do not need to inspect raw payloads.
     *
     * Matches on ErrorCode alone to avoid fragile string comparisons
     * against gateway messages that may change capitalization or wording.
     *
     * Known BPC gateway error codes:
     * - `1` — Order number already registered (possible replay attack)
     * - `3` — Unknown currency
     * - `4` — Missing required parameter
     * - `5` — Access denied (invalid credentials)
     * - `6` — Unknown order ID
     * - `7` — System/internal error
     */
    private validateApiResponse(response: unknown): void {
        const res = response as Record<string, unknown>;
        const rawCode = res.ErrorCode ?? res.errorCode;
        const errorCode = rawCode !== undefined && rawCode !== null ? String(rawCode) : undefined;

        if (res && errorCode && errorCode !== "0") {
            const message = (typeof res.ErrorMessage === "string" ? res.ErrorMessage : undefined)
                ?? (typeof res.errorMessage === "string" ? res.errorMessage : undefined)
                ?? "Unknown error";

            if (errorCode === "5") {
                throw new SatimInvalidCredentialsError("Invalid username or password or terminal ID");
            }
            if (errorCode === "6") {
                throw new SatimInvalidArgumentError("Invalid order ID");
            }
            if (["1", "3", "4", "7"].includes(errorCode)) {
                throw new SatimGatewayError(errorCode, sanitizeGatewayMessage(message));
            }

            throw new SatimUnexpectedResponseError(
                `Gateway error (code ${errorCode}): ${sanitizeGatewayMessage(message)}`,
                "gateway",
            );
        }
    }
}

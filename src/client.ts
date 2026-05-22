/**
 * Low-level HTTP transport for the SATIM REST API.
 *
 * Form-encoded POST with exponential-backoff retries on transient errors
 * and a circuit breaker for gateway protection. Refuses to run with
 * NODE_TLS_REJECT_UNAUTHORIZED=0.
 * @file
 */

import {
    SatimError, SatimInvalidCredentialsError, SatimUnexpectedResponseError,
    SatimInvalidArgumentError, SatimGatewayError,
} from "./exceptions";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker";

export type { CircuitBreakerOptions } from "./circuit-breaker";

const NON_PRINTABLE = /[^\x20-\x7E]/g;

/** Truncate to 200 chars and strip non-printable. Prevents gateway message leakage. */
function sanitizeGatewayMessage(msg: string): string {
    return msg.replace(NON_PRINTABLE, "").slice(0, 200);
}

export interface HttpClientOptions {
    /** Max retries on 5xx/timeout for idempotent calls. Default 2, clamped [0, 10]. */
    maxRetries?: number;
    /** Per-request timeout in ms. Default 30000, range [1000, 300000]. */
    timeoutMs?: number;
    /** Circuit breaker config, or false to disable. */
    circuitBreaker?: CircuitBreakerOptions | false;
}

/**
 * HTTP transport. Validates gateway error codes and translates them to typed errors.
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
     * @param testMode Route to test2.satim.dz when true.
     * @param options Optional transport tuning.
     */
    constructor(private readonly testMode: boolean = false, options?: HttpClientOptions) {
        const r = options?.maxRetries ?? HttpClientService.DEFAULT_MAX_RETRIES;
        this.maxRetries = Math.min(10, Math.max(0, Math.floor(r)));

        const t = options?.timeoutMs ?? HttpClientService.DEFAULT_TIMEOUT_MS;
        if (typeof t !== "number" || !Number.isFinite(t) || t < 1000 || t > 300_000) {
            throw new SatimInvalidArgumentError("timeoutMs must be a number between 1000 and 300000 ms.");
        }
        this.timeoutMs = t;
        this.circuitBreaker = options?.circuitBreaker === false
            ? null
            : new CircuitBreaker(options?.circuitBreaker);
    }

    /**
     * Send a request and validate gateway error codes.
     *
     * @throws SatimInvalidCredentialsError on ErrorCode 5.
     * @throws SatimInvalidArgumentError on ErrorCode 6.
     * @throws SatimGatewayError on ErrorCode 1, 3, 4, 7.
     * @throws SatimUnexpectedResponseError on transport failures or other ErrorCodes.
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

    private getApiUrl(): string {
        return this.testMode ? this.TEST_API_URL : this.API_URL;
    }

    private getRetryDelay(attempt: number): number {
        const base = HttpClientService.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        return base + Math.random() * base * 0.5;
    }

    private isRetryable(err: unknown): boolean {
        return err instanceof SatimUnexpectedResponseError
            && (err.isTimeout || (err.httpStatus !== undefined && err.httpStatus >= 500));
    }

    private assertTlsSafe(): void {
        if (typeof process !== "undefined" && process.env?.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
            throw new SatimError(
                "NODE_TLS_REJECT_UNAUTHORIZED=0 detected. " +
                "Refusing to send payment credentials over an unverified TLS connection.",
            );
        }
    }

    private buildBody(data: Record<string, unknown>): string {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(data)) {
            if (v !== undefined && v !== null) {
                body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
            }
        }
        return body.toString();
    }

    private async sendRequest<T>(
        endpoint: string,
        data: Record<string, unknown>,
        retryable: boolean,
    ): Promise<T> {
        if (this.circuitBreaker && !this.circuitBreaker.allowRequest()) {
            throw new SatimUnexpectedResponseError(
                `Circuit breaker is open after ${this.circuitBreaker.getConsecutiveFailures()} consecutive failures. ` +
                `Requests to the SATIM gateway are temporarily suspended.`,
                "circuit_open",
            );
        }

        const url = `${this.getApiUrl()}${endpoint}`;
        const body = this.buildBody(data);
        const maxAttempts = retryable ? this.maxRetries : 0;
        let lastError: unknown;

        for (let attempt = 0; attempt <= maxAttempts; attempt++) {
            if (attempt > 0) {
                await new Promise((r) => setTimeout(r, this.getRetryDelay(attempt - 1)));
            }
            this.assertTlsSafe();

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
            let counted = false;

            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Cache-Control": "no-store, no-cache",
                        "Pragma": "no-cache",
                    },
                    body,
                    signal: controller.signal,
                });

                if (!response.ok) {
                    const err = new SatimUnexpectedResponseError(
                        `HTTP Error: ${response.status} ${response.statusText}`,
                        "http", undefined, { httpStatus: response.status },
                    );
                    if (response.status >= 500) {
                        this.circuitBreaker?.onFailure();
                        counted = true;
                        if (attempt < maxAttempts) { lastError = err; continue; }
                    }
                    throw err;
                }

                const text = await response.text();
                let parsed: T;
                try {
                    parsed = JSON.parse(text) as T;
                } catch {
                    throw new SatimUnexpectedResponseError("Invalid JSON from API", "parse");
                }
                if (parsed === null || typeof parsed !== "object") {
                    throw new SatimUnexpectedResponseError("API returned a non-object response");
                }

                this.circuitBreaker?.onSuccess();
                return parsed;
            } catch (error) {
                if (error instanceof SatimUnexpectedResponseError) {
                    if (!counted && this.isRetryable(error)) {
                        this.circuitBreaker?.onFailure();
                        if (attempt < maxAttempts) { lastError = error; continue; }
                    }
                    throw error;
                }
                if (error instanceof DOMException && error.name === "AbortError") {
                    const err = new SatimUnexpectedResponseError(
                        `Request timed out after ${this.timeoutMs}ms`,
                        "timeout", undefined, { isTimeout: true },
                    );
                    this.circuitBreaker?.onFailure();
                    if (attempt < maxAttempts) { lastError = err; continue; }
                    throw err;
                }
                throw new SatimUnexpectedResponseError("Network or internal error", "network");
            } finally {
                clearTimeout(timeoutId);
            }
        }
        throw lastError ?? new SatimUnexpectedResponseError("Request failed after retries");
    }

    /**
     * Translate ErrorCode field into typed exceptions.
     * Known codes: 1 dup, 3 currency, 4 missing, 5 creds, 6 unknown order, 7 system.
     */
    private validateApiResponse(response: unknown): void {
        const res = response as Record<string, unknown>;
        const raw = res.ErrorCode ?? res.errorCode;
        const code = raw !== undefined && raw !== null ? String(raw) : undefined;
        if (!code || code === "0") return;

        const message =
            (typeof res.ErrorMessage === "string" ? res.ErrorMessage : undefined) ??
            (typeof res.errorMessage === "string" ? res.errorMessage : undefined) ??
            "Unknown error";

        if (code === "5") {
            throw new SatimInvalidCredentialsError("Invalid username or password or terminal ID");
        }
        if (code === "6") {
            throw new SatimInvalidArgumentError("Invalid order ID");
        }
        if (code === "1" || code === "3" || code === "4" || code === "7") {
            throw new SatimGatewayError(code, sanitizeGatewayMessage(message));
        }
        throw new SatimUnexpectedResponseError(
            `Gateway error (code ${code}): ${sanitizeGatewayMessage(message)}`, "gateway",
        );
    }
}

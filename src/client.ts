/**
 * HTTP transport for the SATIM REST API.
 *
 * Responsibilities:
 * - Form-encode and POST request bodies (the gateway requires
 *   `application/x-www-form-urlencoded`, not JSON).
 * - Per-request timeout via `AbortController`.
 * - Exponential-backoff retry on transient failures (5xx, timeout),
 *   gated by `options.retryable` from the caller.
 * - Circuit breaker integration for fail-fast on sustained gateway degradation.
 * - Map gateway `ErrorCode` values to typed exceptions.
 * - Refuse to operate when `NODE_TLS_REJECT_UNAUTHORIZED=0` is in the env.
 *
 * Backoff schedule: attempt N waits `BASE × 2^(N-1) + uniform(0, BASE×2^(N-1)×0.5)` ms,
 * where `BASE = 500ms`. Max total delay at defaults (maxRetries=2): ~2.25 s.
 * @file
 */

import {
    SatimError, SatimInvalidCredentialsError, SatimUnexpectedResponseError,
    SatimInvalidArgumentError, SatimGatewayError,
} from "./exceptions";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker";

export type { CircuitBreakerOptions } from "./circuit-breaker";

const NON_PRINTABLE = /[^\x20-\x7E]/g;

/**
 * Sanitise a gateway error message before placing it in an SDK exception.
 *
 * Postcondition: returns at most 200 characters of printable ASCII.
 * Strips control characters (which could otherwise break log formats or
 * be used to forge log lines).
 *
 * Complexity: O(n) where n is the input length.
 */
function sanitizeGatewayMessage(msg: string): string {
    return msg.replace(NON_PRINTABLE, "").slice(0, 200);
}

export interface HttpClientOptions {
    /**
     * Maximum retries on transient failures (5xx, timeout) for idempotent
     * calls. Clamped to `[0, 10]`. Default 2.
     */
    maxRetries?: number;
    /**
     * Per-request timeout in milliseconds. Default 30 000.
     * Range: `[1000, 300000]` (1 second to 5 minutes).
     */
    timeoutMs?: number;
    /**
     * Circuit breaker configuration. Pass `false` to disable the breaker
     * entirely (not recommended for production).
     */
    circuitBreaker?: CircuitBreakerOptions | false;
}

/**
 * HTTP transport. One instance per `Satim` client by default; can be
 * shared across multiple `Satim` instances for connection-pool reuse.
 * Concurrent requests against one instance share the embedded breaker;
 * its counter updates are benign under racing `onFailure()` calls (may
 * transiently overshoot the threshold but the breaker still opens).
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
     * Preconditions: `timeoutMs ∈ [1000, 300000]` when supplied;
     * `maxRetries` is clamped to `[0, 10]` and floored.
     *
     * @param testMode Route to `test2.satim.dz` when `true`, else `cib.satim.dz`.
     * @param options Optional transport tuning.
     * @throws {@link SatimInvalidArgumentError} when `timeoutMs` is out of range.
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
     * Send a request and translate gateway error codes into typed exceptions.
     *
     * Preconditions: `endpoint` begins with `/` (concatenated with base URL).
     * `data` carries the form fields to encode.
     *
     * Postcondition on success: returns the parsed JSON response object
     * (always an object, never `null` or primitive).
     *
     * Retry: defaults to `true` for callers that omit `options.retryable`.
     * Mutating endpoints (`register`, `confirm`, `refund`, `reverseOrder`)
     * pass `false` explicitly unless an idempotency key is set.
     *
     * Complexity: O(R × T) where R is `maxRetries + 1` and T is the
     * per-attempt round-trip time. Backoff between attempts is included.
     *
     * @throws {@link SatimInvalidCredentialsError} on `ErrorCode: "5"`.
     * @throws {@link SatimInvalidArgumentError} on `ErrorCode: "6"`.
     * @throws {@link SatimGatewayError} on `ErrorCode` in `{"1","3","4","7"}`.
     * @throws {@link SatimUnexpectedResponseError} on any other error
     *         (network, timeout, parse, non-object response, other
     *         non-zero `ErrorCode`, circuit open).
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

    /** @returns The base URL for the active environment. */
    private getApiUrl(): string {
        return this.testMode ? this.TEST_API_URL : this.API_URL;
    }

    /**
     * Backoff delay before retry `attempt` (0-indexed):
     * `BASE × 2^attempt + uniform(0, BASE × 2^attempt × 0.5)`.
     * Jitter prevents synchronised retry storms across multiple clients.
     */
    private getRetryDelay(attempt: number): number {
        const base = HttpClientService.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        return base + Math.random() * base * 0.5;
    }

    /** Classify whether a thrown error is transient and should be retried. */
    private isRetryable(err: unknown): boolean {
        return err instanceof SatimUnexpectedResponseError
            && (err.isTimeout || (err.httpStatus !== undefined && err.httpStatus >= 500));
    }

    /**
     * Refuse to operate when TLS verification is disabled.
     *
     * Called before every network attempt — checking once at construction
     * would let a process set the env variable after the SDK was instantiated.
     *
     * @throws {@link SatimError} when `NODE_TLS_REJECT_UNAUTHORIZED=0` is in `process.env`.
     */
    private assertTlsSafe(): void {
        if (typeof process !== "undefined" && process.env?.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
            throw new SatimError(
                "NODE_TLS_REJECT_UNAUTHORIZED=0 detected. " +
                "Refusing to send payment credentials over an unverified TLS connection.",
            );
        }
    }

    /**
     * Form-encode the request payload.
     *
     * `undefined` / `null` values are omitted. Objects are JSON-stringified
     * (used for `jsonParams`).
     *
     * Complexity: O(k) where k is the number of fields.
     */
    private buildBody(data: Record<string, unknown>): string {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(data)) {
            if (v !== undefined && v !== null) {
                body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
            }
        }
        return body.toString();
    }

    /**
     * Single request with retry + circuit breaker integration.
     *
     * Circuit breaker accounting: each attempt's failure is counted at most
     * once via the `counted` flag, regardless of which catch branch the
     * exception flows through. Failure paths:
     * - `!response.ok` 5xx: counted in the response-not-ok branch.
     * - `AbortError` (timeout): counted in the abort branch.
     * - `SatimUnexpectedResponseError` from JSON parse or response shape:
     *   counted in the catch branch iff `isRetryable(error)` (which is false
     *   for parse errors — those are not retried).
     *
     * @throws {@link SatimUnexpectedResponseError} on transport or
     *         response-shape failures. Wraps unknown errors as
     *         `errorCategory: "network"`.
     */
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
                        // Anti-caching: POST bodies contain credentials; reverse
                        // proxies and CDN edge nodes must not cache or store them.
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
     * Translate gateway `ErrorCode` into typed exceptions.
     *
     * `ErrorCode` mapping:
     *
     * | Code | Exception | Notes |
     * |------|-----------|-------|
     * | `"0"` / absent | (no error) | Successful response. |
     * | `"1"` | {@link SatimGatewayError} | Duplicate order — detected by `safeRegister`. |
     * | `"3"` | {@link SatimGatewayError} | Unknown currency. |
     * | `"4"` | {@link SatimGatewayError} | Missing required parameter. |
     * | `"5"` | {@link SatimInvalidCredentialsError} | Invalid username/password/terminal. |
     * | `"6"` | {@link SatimInvalidArgumentError} | Unknown order ID. |
     * | `"7"` | {@link SatimGatewayError} | Gateway internal error. |
     * | any other non-zero | {@link SatimUnexpectedResponseError} | Carries `errorCategory: "gateway"`. |
     *
     * Gateway error messages are sanitised via {@link sanitizeGatewayMessage}
     * before being placed in exceptions.
     *
     * @throws The exception corresponding to the gateway's `ErrorCode`.
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

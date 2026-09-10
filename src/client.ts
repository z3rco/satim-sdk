/**
 * HTTP transport for the SATIM REST API: form-encodes and POSTs requests
 * (gateway requires `application/x-www-form-urlencoded`), applies a
 * per-request timeout, retries transient failures with exponential
 * backoff, integrates a circuit breaker, maps `ErrorCode` to typed
 * exceptions, and refuses to run with `NODE_TLS_REJECT_UNAUTHORIZED=0`.
 * @file
 */

import {
    SatimError, SatimInvalidCredentialsError, SatimUnexpectedResponseError,
    SatimInvalidArgumentError, SatimGatewayError,
} from "./exceptions.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.js";
import { sha256Hex } from "./crypto.js";
import { isPrivateHost } from "./ssrf.js";

export type { CircuitBreakerOptions } from "./circuit-breaker.js";

const NON_PRINTABLE = /[^\x20-\x7E]/g;

/**
 * Sanitise a gateway error message before placing it in an SDK exception.
 * Strips control characters (could forge log lines) and truncates to 200
 * printable ASCII characters.
 */
function sanitizeGatewayMessage(msg: string): string {
    return msg.replace(NON_PRINTABLE, "").slice(0, 200);
}

/**
 * True for an abort/timeout rejection from any `fetch` implementation.
 * Matches by `name`, not `instanceof DOMException`, because custom
 * fetches (see {@link HttpClientOptions.fetch}) may reject with a plain
 * `Error` carrying the same name.
 */
function isAbortError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const name = (error as { name?: unknown }).name;
    return name === "AbortError" || name === "TimeoutError";
}

/** Transport tuning for {@link HttpClientService}. All fields optional. */
export interface HttpClientOptions {
    /**
     * Maximum retries on transient failures (5xx, timeout, connection
     * failure) for idempotent calls. Clamped to `[0, 10]`. Default 2.
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
    /**
     * Custom `fetch` implementation. Defaults to the global `fetch`.
     * Inject an undici `Pool`-backed fetch on Node.js for connection
     * pooling/HTTP2; leave unset on edge runtimes, which already pool.
     */
    fetch?: typeof globalThis.fetch;
    /**
     * Override the REST root, e.g. `"http://localhost:8787/payment/rest"`.
     *
     * SATIM assigns some merchants a host other than the two defaults, and
     * local development needs to reach a mock. Give the root without a
     * trailing slash and without the endpoint segment; it replaces the
     * host `testMode` would otherwise select.
     *
     * Plaintext `http:` is accepted only for loopback and private hosts —
     * every request carries the merchant password in its body, so a
     * plaintext URL to a public host is refused rather than trusted.
     */
    baseUrl?: string;
}

/**
 * HTTP transport. One instance per `Satim` client by default; can be
 * shared across instances for connection-pool reuse. Concurrent requests
 * share the embedded breaker; racing counter updates are benign.
 */
export class HttpClientService {
    private readonly API_URL = "https://cib.satim.dz/payment/rest";
    private readonly TEST_API_URL = "https://test2.satim.dz/payment/rest";
    /** Caller-supplied REST root; overrides the `testMode` default when set. */
    private readonly baseUrl: string | undefined;
    private static readonly DEFAULT_TIMEOUT_MS = 30_000;
    private static readonly DEFAULT_MAX_RETRIES = 2;
    private static readonly BASE_RETRY_DELAY_MS = 500;

    private readonly maxRetries: number;
    private readonly timeoutMs: number;
    private readonly circuitBreaker: CircuitBreaker | null;
    /** Custom fetch supplied by the caller; `undefined` means use `globalThis.fetch` lazily. */
    private readonly fetchImpl: typeof globalThis.fetch | undefined;
    /** Deduplicates concurrent identical idempotent requests (same endpoint + body). */
    private readonly _inflight = new Map<string, Promise<unknown>>();

    /**
     * `timeoutMs` must be in `[1000, 300000]`; `maxRetries` is clamped to `[0, 10]`.
     * @param testMode Route to `test2.satim.dz` when `true`, else `cib.satim.dz`.
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
        this.fetchImpl = options?.fetch; // undefined → use globalThis.fetch lazily at call time
        this.baseUrl = HttpClientService.normaliseBaseUrl(options?.baseUrl);
    }

    /**
     * Validate an overridden REST root and strip any trailing slash.
     *
     * @throws {@link SatimInvalidArgumentError} when the URL is malformed,
     *         not HTTP(S), or plaintext `http:` to a non-private host.
     */
    private static normaliseBaseUrl(raw: string | undefined): string | undefined {
        if (raw === undefined) return undefined;
        let parsed: URL;
        try {
            parsed = new URL(raw);
        } catch {
            throw new SatimInvalidArgumentError("baseUrl must be a valid http/https URL.");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new SatimInvalidArgumentError("baseUrl must be a valid http/https URL.");
        }
        if (parsed.protocol === "http:" && !isPrivateHost(parsed.hostname)) {
            throw new SatimInvalidArgumentError(
                "baseUrl must use HTTPS for non-local hosts: every request body carries the merchant password.",
            );
        }
        return raw.replace(/\/+$/, "");
    }

    /**
     * Send a request and translate gateway error codes into typed exceptions.
     * `endpoint` must begin with `/`. Defaults `retryable` to `true`;
     * mutating endpoints pass `false` unless an idempotency key is set.
     * @throws {@link SatimInvalidCredentialsError} on `ErrorCode: "5"`.
     * @throws {@link SatimInvalidArgumentError} on `ErrorCode: "6"`.
     * @throws {@link SatimGatewayError} on `ErrorCode` in `{"1","3","4","7"}`.
     * @throws {@link SatimUnexpectedResponseError} on any other error.
     */
    public handleApiRequest<T = unknown>(
        endpoint: string,
        data: Record<string, unknown>,
        options?: { retryable?: boolean },
    ): Promise<T> {
        const retryable = options?.retryable ?? true;

        if (!retryable) {
            return this.sendRequest<T>(endpoint, data, false)
                .then(result => { this.validateApiResponse(result); return result; });
        }

        // Collapse concurrent identical idempotent requests into one round trip.
        // Keyed by a hash, not the raw body: the body carries the merchant
        // password, and a raw key would leave it readable in `_inflight`.
        const key = `${endpoint}:${sha256Hex(this.buildBody(data))}`;
        const existing = this._inflight.get(key) as Promise<T> | undefined;
        if (existing) return existing;

        const promise: Promise<T> = this.sendRequest<T>(endpoint, data, true)
            .then(result => { this.validateApiResponse(result); return result; })
            .finally(() => this._inflight.delete(key));
        this._inflight.set(key, promise);
        return promise;
    }

    /** @returns The base URL for the active environment. */
    private getApiUrl(): string {
        return this.baseUrl ?? (this.testMode ? this.TEST_API_URL : this.API_URL);
    }

    /**
     * Backoff delay before retry `attempt` (0-indexed). Jitter prevents
     * synchronised retry storms across multiple clients.
     */
    private getRetryDelay(attempt: number): number {
        const base = HttpClientService.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        return base + Math.random() * base * 0.5;
    }

    /**
     * Retryable: timeouts, connection failures, 5xx. Not retryable: 4xx
     * and malformed-payload errors (next attempt would fail the same
     * way), and `circuit_open` (the breaker's own signal).
     */
    private isRetryable(err: SatimUnexpectedResponseError): boolean {
        if (err.errorCategory === "circuit_open") return false;
        if (err.httpStatus !== undefined) return err.httpStatus >= 500;
        return err.isTimeout
            || err.errorCategory === "timeout"
            || err.errorCategory === "network";
    }

    /**
     * Whether an error counts toward opening the breaker. Counted:
     * timeouts, connection failures, 5xx, malformed/non-object payloads
     * (e.g. an HTML error page through a proxy despite HTTP 200). Not
     * counted: 4xx (client-side, waiting won't help) and `circuit_open`.
     */
    private countsAsGatewayFailure(err: SatimUnexpectedResponseError): boolean {
        if (err.errorCategory === "circuit_open") return false;
        if (err.httpStatus !== undefined) return err.httpStatus >= 500;
        return true;
    }

    /**
     * Normalise anything thrown by `fetch` into a `SatimUnexpectedResponseError`.
     * Relies on {@link isAbortError}'s name-based match so custom `fetch`
     * implementations still set `isTimeout` correctly.
     */
    private toTransportError(error: unknown): SatimUnexpectedResponseError {
        if (error instanceof SatimUnexpectedResponseError) return error;
        if (isAbortError(error)) {
            return new SatimUnexpectedResponseError(
                `Request timed out after ${this.timeoutMs}ms`,
                "timeout", undefined, { isTimeout: true },
            );
        }
        return new SatimUnexpectedResponseError("Network or internal error", "network");
    }

    /**
     * Refuse to operate when TLS verification is disabled. Checked per
     * request, not once at construction, so enabling it later is still caught.
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
     * Form-encode the request payload. `undefined`/`null` values are
     * omitted; objects are JSON-stringified (used for `jsonParams`).
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
     * Single request with retry + circuit breaker integration. Every
     * attempt must funnel through the single `catch` below and report
     * exactly one `onSuccess()`/`onFailure()`: a path reporting neither
     * blinds the breaker to that failure mode and can strand a
     * `HALF_OPEN` probe. A `throw` inside `try` is safe; one bypassing
     * this `catch` is not.
     * @throws {@link SatimUnexpectedResponseError} on transport/response failures.
     */
    private async sendRequest<T>(
        endpoint: string,
        data: Record<string, unknown>,
        retryable: boolean,
    ): Promise<T> {
        // Checked before the breaker gate so a config fault never consumes
        // the single HALF_OPEN probe.
        this.assertTlsSafe();

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
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

            try {
                const response = await (this.fetchImpl ?? globalThis.fetch)(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        // POST bodies contain credentials; forbid caching by proxies/CDNs.
                        "Cache-Control": "no-store, no-cache",
                        "Pragma": "no-cache",
                    },
                    body,
                    signal: controller.signal,
                });

                if (!response.ok) {
                    throw new SatimUnexpectedResponseError(
                        `HTTP Error: ${response.status} ${response.statusText}`,
                        "http", undefined, { httpStatus: response.status },
                    );
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
                // A tripped local guard (e.g. TLS disabled) is a config
                // fault, not a gateway signal: propagate untouched, don't
                // touch breaker counters.
                if (error instanceof SatimError && !(error instanceof SatimUnexpectedResponseError)) {
                    throw error;
                }
                const err = this.toTransportError(error);
                if (this.countsAsGatewayFailure(err)) this.circuitBreaker?.onFailure();
                if (this.isRetryable(err) && attempt < maxAttempts) { lastError = err; continue; }
                throw err;
            } finally {
                clearTimeout(timeoutId);
            }
        }
        throw lastError ?? new SatimUnexpectedResponseError("Request failed after retries");
    }

    /**
     * Translate gateway `ErrorCode` into typed exceptions; see the `if`
     * chain below for the code-to-exception mapping. Messages are passed
     * through {@link sanitizeGatewayMessage} first.
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

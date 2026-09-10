/**
 * HTTP transport for the SATIM REST API.
 *
 * Responsibilities:
 * - Form-encode and POST request bodies (the gateway requires
 *   `application/x-www-form-urlencoded`, not JSON).
 * - Per-request timeout via `AbortController`.
 * - Exponential-backoff retry on transient failures (5xx, timeout,
 *   connection failure), gated by `options.retryable` from the caller.
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
} from "./exceptions.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.js";
import { sha256Hex } from "./crypto.js";

export type { CircuitBreakerOptions } from "./circuit-breaker.js";

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

/**
 * True for an abort/timeout rejection from any `fetch` implementation.
 *
 * Matches by `name` so it holds for the global `fetch`'s `DOMException`,
 * for custom fetches that reject with a plain `Error`, and for
 * implementations that surface `AbortSignal.timeout` as `TimeoutError`.
 */
function isAbortError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const name = (error as { name?: unknown }).name;
    return name === "AbortError" || name === "TimeoutError";
}

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
     *
     * Inject an undici `Pool`-backed fetch on Node.js to enable true
     * connection pooling and HTTP/2 multiplexing:
     *
     * ```ts
     * import { Pool } from "undici";
     * const pool = new Pool("https://cib.satim.dz");
     * const satim = new Satim(credentials, { fetch: pool.fetch.bind(pool) });
     * ```
     *
     * On edge runtimes (Cloudflare Workers, Vercel Edge) the global fetch
     * already pools connections — leave this unset.
     */
    fetch?: typeof globalThis.fetch;
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
    /** Custom fetch supplied by the caller; `undefined` means use `globalThis.fetch` lazily. */
    private readonly fetchImpl: typeof globalThis.fetch | undefined;
    /** Deduplicates concurrent identical idempotent requests (same endpoint + body). */
    private readonly _inflight = new Map<string, Promise<unknown>>();

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
        this.fetchImpl = options?.fetch; // undefined → use globalThis.fetch lazily at call time
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

        // Collapse concurrent identical idempotent requests into one in-flight call.
        // Two callers awaiting status for the same orderId share one round trip.
        // The body is hashed rather than used verbatim: it carries the merchant
        // password, and a raw key would leave that credential sitting in a Map
        // key where a heap dump or a debugger inspecting `_inflight` would read
        // it in plaintext.
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

    /**
     * Classify whether a transport error is transient and worth retrying.
     *
     * Retryable: timeouts, connection-level failures (`errorCategory:
     * "network"` — DNS failure, ECONNREFUSED, TLS handshake error), and
     * 5xx responses. Not retryable: 4xx, malformed-payload (`parse`) and
     * response-shape errors — the gateway will produce the same bad
     * payload on the next attempt — and `circuit_open`, which is the
     * breaker's own fail-fast signal.
     */
    private isRetryable(err: SatimUnexpectedResponseError): boolean {
        if (err.errorCategory === "circuit_open") return false;
        if (err.httpStatus !== undefined) return err.httpStatus >= 500;
        return err.isTimeout
            || err.errorCategory === "timeout"
            || err.errorCategory === "network";
    }

    /**
     * Decide whether an error is evidence of gateway degradation and
     * should count toward opening the breaker.
     *
     * Counted: timeouts, connection failures, 5xx, and malformed or
     * non-object payloads (a gateway returning an HTML error page through
     * its proxy is degraded, even though the HTTP status says 200).
     *
     * Not counted: 4xx (the SDK sent something the gateway disliked — a
     * client-side problem that more waiting will not fix) and
     * `circuit_open` (the breaker's own output, never its input).
     */
    private countsAsGatewayFailure(err: SatimUnexpectedResponseError): boolean {
        if (err.errorCategory === "circuit_open") return false;
        if (err.httpStatus !== undefined) return err.httpStatus >= 500;
        return true;
    }

    /**
     * Normalise anything thrown by `fetch` into a `SatimUnexpectedResponseError`.
     *
     * Abort detection matches on `name` rather than `instanceof DOMException`:
     * the global `fetch` rejects aborts with a `DOMException`, but a custom
     * `fetch` (the documented production path — see {@link HttpClientOptions.fetch})
     * may reject with a plain `Error` or a library-specific class carrying
     * the same `name`. An `instanceof` check misclassifies those as generic
     * network errors, which loses the `isTimeout` flag callers branch on.
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
     * Refuse to operate when TLS verification is disabled.
     *
     * Called at the start of every request — checking once at construction
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
     * Circuit breaker accounting: every attempt funnels through the single
     * `catch` below, which normalises the error and then makes exactly one
     * accounting decision. This matters more than it looks — the breaker
     * requires that a `true` from `allowRequest()` be answered by exactly
     * one `onSuccess()`/`onFailure()`. An exit path reporting neither both
     * blinds the breaker (it never opens on that failure mode) and, if the
     * attempt happened to be the `HALF_OPEN` probe, strands the breaker
     * with `probeInFlight` set. Adding an early `throw` anywhere in the
     * `try` block is therefore safe; adding one that bypasses this `catch`
     * is not.
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
        // Checked before the breaker gate so a configuration fault never
        // consumes the single HALF_OPEN probe, and re-checked per request
        // rather than once at construction so a process that disables TLS
        // verification after instantiating the SDK is still caught.
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
                        // Anti-caching: POST bodies contain credentials; reverse
                        // proxies and CDN edge nodes must not cache or store them.
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
                // A local guard tripping (TLS verification disabled) is a
                // configuration fault, not a gateway signal: propagate it
                // untouched and leave the breaker's counters alone, so
                // fixing the environment does not leave a circuit open.
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

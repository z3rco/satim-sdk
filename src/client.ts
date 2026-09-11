import {
    SatimError, SatimInvalidCredentialsError, SatimUnexpectedResponseError,
    SatimInvalidArgumentError, SatimGatewayError,
} from "./exceptions.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.js";
import { sha256Hex } from "./crypto.js";
import { isPrivateHost } from "./ssrf.js";

export type { CircuitBreakerOptions } from "./circuit-breaker.js";

const NON_PRINTABLE = /[^\x20-\x7E]/g;

const PERMISSION_GATED = ["/deposit.do", "/refund.do", "/reverse.do", "/decline.do"];

function sanitizeGatewayMessage(msg: string): string {
    return msg.replace(NON_PRINTABLE, "").slice(0, 200);
}

// Match by name, not instanceof DOMException: a custom fetch may reject a timeout with a plain Error.
function isAbortError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const name = (error as { name?: unknown }).name;
    return name === "AbortError" || name === "TimeoutError";
}

export interface HttpClientOptions {

    maxRetries?: number;

    timeoutMs?: number;

    circuitBreaker?: CircuitBreakerOptions | false;

    fetch?: typeof globalThis.fetch;

    baseUrl?: string;
}

export class HttpClientService {
    private readonly API_URL = "https://cib.satim.dz/payment/rest";
    private readonly TEST_API_URL = "https://test2.satim.dz/payment/rest";

    private readonly baseUrl: string | undefined;
    private static readonly DEFAULT_TIMEOUT_MS = 30_000;
    private static readonly DEFAULT_MAX_RETRIES = 2;
    private static readonly BASE_RETRY_DELAY_MS = 500;

    private readonly maxRetries: number;
    private readonly timeoutMs: number;
    private readonly circuitBreaker: CircuitBreaker | null;

    private readonly fetchImpl: typeof globalThis.fetch | undefined;

    private readonly _inflight = new Map<string, Promise<unknown>>();

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
        this.fetchImpl = options?.fetch;
        this.baseUrl = HttpClientService.normaliseBaseUrl(options?.baseUrl);
    }

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

    public handleApiRequest<T = unknown>(
        endpoint: string,
        data: Record<string, unknown>,
        options?: { retryable?: boolean },
    ): Promise<T> {
        const retryable = options?.retryable ?? true;

        if (!retryable) {
            return this.sendRequest<T>(endpoint, data, false)
                .then(result => { this.validateApiResponse(result, endpoint); return result; });
        }

        // Hash the body, not the raw form: it carries the merchant password.
        const key = `${endpoint}:${sha256Hex(this.buildBody(data))}`;
        const existing = this._inflight.get(key) as Promise<T> | undefined;
        if (existing) return existing;

        const promise: Promise<T> = this.sendRequest<T>(endpoint, data, true)
            .then(result => { this.validateApiResponse(result, endpoint); return result; })
            .finally(() => this._inflight.delete(key));
        this._inflight.set(key, promise);
        return promise;
    }

    private getApiUrl(): string {
        return this.baseUrl ?? (this.testMode ? this.TEST_API_URL : this.API_URL);
    }

    private getRetryDelay(attempt: number): number {
        const base = HttpClientService.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        return base + Math.random() * base * 0.5;
    }

    private isRetryable(err: SatimUnexpectedResponseError): boolean {
        if (err.errorCategory === "circuit_open") return false;
        if (err.httpStatus !== undefined) return err.httpStatus >= 500;
        return err.isTimeout
            || err.errorCategory === "timeout"
            || err.errorCategory === "network";
    }

    // 4xx is a client-side fault, not gateway degradation, so it must not open the breaker.
    private countsAsGatewayFailure(err: SatimUnexpectedResponseError): boolean {
        if (err.errorCategory === "circuit_open") return false;
        if (err.httpStatus !== undefined) return err.httpStatus >= 500;
        return true;
    }

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

        // Before the breaker gate: a config fault must not consume the single HALF_OPEN probe.
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

                        "Cache-Control": "no-store, no-cache",
                        "Pragma": "no-cache",
                    },
                    body,
                    signal: controller.signal,
                });

                if (!response.ok) {

                    // acknowledgeTransaction.do reports bad creds as 401, register.do as errorCode 5; type both the same.
                    if (response.status === 401 || response.status === 403) {
                        throw new SatimInvalidCredentialsError(
                            "Invalid username or password or terminal ID",
                        );
                    }
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

                // Local guards (e.g. the TLS check) propagate untouched; only transport errors reach the breaker.
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

    private validateApiResponse(response: unknown, endpoint = ""): void {
        const res = response as Record<string, unknown>;
        const raw = res.ErrorCode ?? res.errorCode;
        const code = raw !== undefined && raw !== null ? String(raw) : undefined;
        if (!code || code === "0") return;

        const message =
            (typeof res.ErrorMessage === "string" ? res.ErrorMessage : undefined) ??
            (typeof res.errorMessage === "string" ? res.errorMessage : undefined) ??
            "Unknown error";

        if (code === "5") {
            // errorCode 5 on a gated endpoint is ambiguous: wrong credentials, or terminal not entitled.
            throw new SatimInvalidCredentialsError(
                PERMISSION_GATED.some((e) => endpoint.includes(e))
                    ? "Access denied. Either the credentials are wrong, or this operation is not "
                      + "enabled for your terminal — deposit, refund, reverse and decline are "
                      + "permission-gated per merchant. Run satim.checkCapabilities() to tell them apart."
                    : "Invalid username or password or terminal ID",
            );
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

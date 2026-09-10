/**
 * Primary client facade for the SATIM REST API.
 *
 * Extends `SatimConfig` for the immutable fluent setter API and owns the
 * `HttpClientService` instance. Each endpoint method validates its inputs,
 * builds the form payload, dispatches via the HTTP client, and wraps the
 * response in `RegisterResponse` or `ConfirmResponse`.
 *
 * Retry semantics per endpoint:
 *
 * | Endpoint | Retryable | Why |
 * |----------|-----------|-----|
 * | `register` / `registerPreAuth` | Iff `_idempotencyKey` is set | Otherwise retry could duplicate orders. |
 * | `confirm` | No | Final-state query; retry would double-fire merchant side effects. |
 * | `status` | Yes | Idempotent read. |
 * | `refund` | No | Mutation without idempotency primitive. |
 * | `reverseOrder` | No | Mutation without idempotency primitive. |
 *
 * `safeRegister` / `safeRegisterPreAuth` derive a deterministic idempotency
 * key from the caller's `merchantRef`, set it before dispatch, and
 * translate gateway `ErrorCode: "1"` into {@link SatimDuplicateOrderError}.
 * @file
 */

import { SatimConfig } from "./config.js";
import { HttpClientService, type HttpClientOptions } from "./client.js";
import {
    SatimMissingDataError, SatimInvalidArgumentError,
    SatimDuplicateOrderError, SatimGatewayError,
} from "./exceptions.js";
import type { SatimCredentials, RegisterOrderResponse, ConfirmOrderResponse } from "./types.js";
import { RegisterResponse } from "./responses/register.js";
import { ConfirmResponse } from "./responses/confirm.js";
import { toMinorUnits } from "./money.js";
import { assertOrderId, assertConfirmAmount, assertRefundAmount } from "./validation.js";
import { deriveIdempotencyKey, deriveOrderNumber } from "./idempotency.js";
import { randomOrderNumber } from "./crypto.js";
import { WebhookHandler, type WebhookHandlerOptions } from "./webhook/handler.js";

/** Key always stripped from caller-supplied `jsonParams` then set from the credential store. */
const FORCE_TERMINAL_KEY = "force_terminal_id";

/**
 * SATIM REST API client.
 *
 * Construction binds credentials to a module-private `WeakMap` entry (see
 * {@link SatimConfig.initFromCredentials}). The HTTP client is either
 * caller-injected or built with the provided options.
 *
 * Instances are safe to share across concurrent requests because every
 * fluent setter returns a clone — no caller can mutate state observed by
 * another caller.
 */
export class Satim extends SatimConfig {
    protected httpClientService: HttpClientService;
    /** `true` when the caller passed an `HttpClientService` instance — `setTestMode` will not rebuild it. */
    private readonly _hasCustomHttpClient: boolean;
    /** Options remembered so `setTestMode` can rebuild the default transport. */
    private readonly _httpClientOptions: HttpClientOptions | undefined;

    /**
     * Preconditions: `credentials` satisfies {@link SatimCredentials} with
     * all fields non-empty after trim and within length limits (AN.100 / AN.16).
     *
     * @param credentials Merchant credentials from CIBWeb.
     * @param httpClientService Either a pre-built `HttpClientService` (for
     *        testing or shared connection pools) or an `HttpClientOptions`
     *        object configuring the default transport.
     * @throws {@link SatimInvalidArgumentError} / {@link SatimMissingDataError}
     *         on invalid credentials (via `initFromCredentials`).
     * @throws {@link SatimInvalidArgumentError} on invalid `timeoutMs`
     *         when default transport is built.
     */
    constructor(credentials: SatimCredentials, httpClientService?: HttpClientService | HttpClientOptions) {
        super();
        this.initFromCredentials(credentials);
        if (httpClientService instanceof HttpClientService) {
            this._hasCustomHttpClient = true;
            this._httpClientOptions = undefined;
            this.httpClientService = httpClientService;
        } else {
            this._hasCustomHttpClient = false;
            this._httpClientOptions = httpClientService;
            this.httpClientService = new HttpClientService(this.testMode, httpClientService);
        }
    }

    /**
     * Override to rebuild the default HTTP client when `testMode` changes
     * (the base URL is baked in at construction). A caller-injected
     * client is preserved verbatim — switching `testMode` will not
     * replace it.
     *
     * @returns Clone with `testMode` set and (if applicable) a fresh
     *          default `HttpClientService` matching the new mode.
     */
    public override setTestMode(isEnabled: boolean): this {
        const clone = super.setTestMode(isEnabled);
        if (!clone._hasCustomHttpClient) {
            clone.httpClientService = new HttpClientService(clone.testMode, clone._httpClientOptions);
        }
        return clone;
    }

    /**
     * Override to copy transport-related state alongside config state.
     *
     * The base `SatimConfig.clone` only knows about config fields; the
     * `Satim` subclass owns `httpClientService` and two private flags
     * that must also propagate. Uses cast-to-any because the fields are
     * declared `readonly` — only the clone's constructor-equivalent
     * (this method) may set them.
     */
    protected override clone(): this {
        const c = super.clone();
        c.httpClientService = this.httpClientService;
        (c as any)._hasCustomHttpClient = this._hasCustomHttpClient;
        (c as any)._httpClientOptions = this._httpClientOptions;
        return c;
    }

    // ─── Registration endpoints ──────────────────────────────────────────

    /**
     * Register a new payment order via `/register.do`.
     *
     * Preconditions: `_returnUrl` and `_amount` are set via the fluent
     * setters. `_amount` already validated against `assertRegisterAmount`.
     *
     * Postcondition: returns a `RegisterResponse` whose `getOrderId` and
     * `getUrl` are populated.
     *
     * Retry: enabled iff `_idempotencyKey` is set.
     *
     * Complexity: O(network).
     *
     * @throws {@link SatimMissingDataError} when required fields are absent.
     * @throws {@link SatimGatewayError} on `ErrorCode` 1, 3, 4, 7.
     * @throws {@link SatimInvalidCredentialsError} on `ErrorCode` 5.
     * @throws {@link SatimUnexpectedResponseError} on transport failures
     *         or other non-zero error codes.
     */
    public register(): Promise<RegisterResponse> {
        return this.registerAt("/register.do");
    }

    /**
     * Register a pre-authorization (fund hold) via `/registerPreAuth.do`.
     *
     * Holds the funds on the customer's card without capturing. Capture
     * later via `confirm()` or release via `reverseOrder()`.
     *
     * Same preconditions, postconditions, retry semantics, and exceptions
     * as {@link register}.
     */
    public registerPreAuth(): Promise<RegisterResponse> {
        return this.registerAt("/registerPreAuth.do");
    }

    // ─── Order management endpoints ──────────────────────────────────────

    /**
     * Confirm (deposit) a payment via `/public/acknowledgeTransaction.do`.
     *
     * Preconditions: `orderId` matches the strict order-ID format;
     * `expectedAmount` passes `assertConfirmAmount` (finite, positive,
     * ≤ MAX_SAFE_AMOUNT, ≤ 2 decimal places).
     *
     * Postcondition: returns a `ConfirmResponse`. When the response
     * satisfies `isSuccessful()`, `verifyAmount(expectedAmount)` has
     * already run — a mismatch throws before this method returns.
     *
     * Retry: disabled. A retry could double-fire merchant side effects
     * derived from observing the success state.
     *
     * Security: this is the only safe path to confirm a payment. The
     * automatic amount check defends against partial-capture
     * manipulation; the call must happen server-side, never from the
     * customer's browser.
     *
     * Complexity: O(network).
     *
     * @throws {@link SatimInvalidArgumentError} on malformed `orderId`
     *         or `expectedAmount`.
     * @throws {@link SatimUnexpectedResponseError} on amount mismatch
     *         (carries the expected vs actual minor-unit values).
     * @throws Any gateway/transport exception per `handleApiRequest`.
     */
    public async confirm(orderId: string, expectedAmount: number): Promise<ConfirmResponse> {
        assertOrderId(orderId, "confirmation");
        assertConfirmAmount(expectedAmount);

        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/public/acknowledgeTransaction.do",
            { userName: this.username, password: this.password, mdOrder: orderId, language: this._language },
            { retryable: false },
        );
        const response = new ConfirmResponse(result);
        if (response.isSuccessful()) response.verifyAmount(expectedAmount);
        return response;
    }

    /**
     * Query order status via `/getOrderStatus.do`.
     *
     * Idempotent — automatically retried on transient failures (5xx, timeout).
     * Concurrent calls for the same `orderId` are collapsed into a single
     * in-flight request — the second caller receives the first's response
     * without a second round trip.
     *
     * Preconditions: `orderId` matches the strict order-ID format.
     *
     * Complexity: O(network) — but up to `1 + maxRetries` round trips on
     * transient errors.
     *
     * @throws {@link SatimInvalidArgumentError} on malformed `orderId`.
     * @throws Any gateway/transport exception per `handleApiRequest`.
     */
    public async status(orderId: string): Promise<ConfirmResponse> {
        assertOrderId(orderId, "status check");
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/getOrderStatus.do",
            { userName: this.username, password: this.password, orderId, language: this._language },
        );
        return new ConfirmResponse(result);
    }

    /**
     * Query multiple orders in parallel via concurrent `/getOrderStatus.do` calls.
     *
     * Fires all queries simultaneously. Concurrent calls for the same `orderId`
     * are deduplicated by `HttpClientService` — passing duplicates in the array
     * does not multiply requests.
     *
     * Rejects with the first error encountered; all in-flight requests still run
     * to completion (standard `Promise.all` semantics).
     *
     * @throws {@link SatimInvalidArgumentError} on any malformed `orderId`.
     * @throws Any gateway/transport exception per `handleApiRequest`.
     */
    public statusAll(orderIds: string[]): Promise<ConfirmResponse[]> {
        return Promise.all(orderIds.map(id => this.status(id)));
    }

    /**
     * Pre-warm the TCP+TLS connection to the SATIM gateway.
     *
     * Call this once during application startup (or just before a checkout
     * flow begins) to avoid paying the TCP handshake + TLS negotiation cost
     * (~50–200 ms) on the first real payment request.
     *
     * Sends a single probe request to `/getOrderStatus.do` with a known-unknown
     * order ID. The gateway responds immediately with ErrorCode 6; the
     * connection is then established and kept alive for subsequent requests.
     *
     * This method never throws — if the probe fails (network down, gateway
     * unreachable) the error is silently discarded. The only consequence is
     * that the first real request will incur the normal handshake cost.
     */
    public async warmup(): Promise<void> {
        try {
            await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
                "/getOrderStatus.do",
                { userName: this.username, password: this.password, orderId: "00000000-0000-0000-0000-000000000000", language: this._language },
                { retryable: false },
            );
        } catch { /* expected: ErrorCode 6 for unknown probe order */ }
    }

    /**
     * Refund a captured payment via `/refund.do`.
     *
     * Retry: disabled. A retry could double-refund.
     *
     * Preconditions: `orderId` valid; `amount` passes `assertRefundAmount`
     * (finite, positive, ≤ MAX_SAFE_AMOUNT, ≤ 2 decimal places, ≥ 1
     * minor unit after conversion).
     *
     * @throws {@link SatimInvalidArgumentError} on malformed inputs.
     * @throws Any gateway/transport exception per `handleApiRequest`.
     */
    public async refund(orderId: string, amount: number): Promise<ConfirmResponse> {
        assertOrderId(orderId, "refund");
        assertRefundAmount(amount);
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/refund.do",
            {
                userName: this.username, password: this.password, orderId,
                amount: toMinorUnits(amount), currency: this._currency, language: this._language,
            },
            { retryable: false },
        );
        return new ConfirmResponse(result);
    }

    /**
     * Void a pre-settlement payment via `/reverse.do`.
     *
     * Cheaper than refund — cancels the authorization before the acquirer
     * settles, avoiding processing fees. Applies to status `1`
     * (pre-authorized) and `2` (deposited but not yet settled) orders.
     *
     * Retry: disabled.
     *
     * @throws {@link SatimInvalidArgumentError} on malformed `orderId`.
     * @throws Any gateway/transport exception per `handleApiRequest`.
     */
    public async reverseOrder(orderId: string): Promise<ConfirmResponse> {
        assertOrderId(orderId, "reversal");
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/reverse.do",
            { userName: this.username, password: this.password, orderId, language: this._language },
            { retryable: false },
        );
        return new ConfirmResponse(result);
    }

    // ─── Safe (idempotent) registration ──────────────────────────────────

    /**
     * Register with automatic idempotency.
     *
     * Derives a deterministic `externalRequestId` and `orderNumber` from
     * `merchantRef`, then calls {@link register}. Safe to retry — the
     * gateway deduplicates on the derived key.
     *
     * If the gateway returns `ErrorCode: "1"` (duplicate order with a
     * conflicting amount/currency for the same `merchantRef`), the
     * `SatimGatewayError` is translated to {@link SatimDuplicateOrderError}
     * so callers can recover via `status(originalOrderId)` from their
     * own persistence layer.
     *
     * Preconditions: `merchantRef` is a non-empty string after trim;
     * `_returnUrl` and `_amount` set.
     *
     * Postcondition: same as {@link register}.
     *
     * @throws {@link SatimInvalidArgumentError} when `merchantRef` is empty.
     * @throws {@link SatimMissingDataError} when registration prerequisites missing.
     * @throws {@link SatimDuplicateOrderError} on conflicting prior registration.
     * @throws Any other exception `register()` can throw.
     */
    public safeRegister(merchantRef: string): Promise<RegisterResponse> {
        return this.safeRegisterAt(merchantRef, "register");
    }

    /**
     * Pre-authorization variant of {@link safeRegister}.
     *
     * Domain-separated from `safeRegister` via the `"preauth"` mode tag in
     * the derived key — a `register` key never collides with a `preauth`
     * key for the same `merchantRef`.
     */
    public safeRegisterPreAuth(merchantRef: string): Promise<RegisterResponse> {
        return this.safeRegisterAt(merchantRef, "preauth");
    }

    // ─── Webhook ─────────────────────────────────────────────────────────

    /**
     * Build a zero-trust webhook handler bound to this `Satim` instance.
     *
     * The handler re-verifies state server-to-server on every callback
     * via this client's `confirm()` method. See
     * [`webhook/README.md`](./webhook/README.md) for the verification
     * flow and distributed-deployment requirements.
     *
     * @throws {@link SatimMissingDataError} when `onResolveAmount` is missing.
     * @throws {@link SatimInvalidArgumentError} on rate-limiter parameter violations.
     */
    public createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler {
        return new WebhookHandler(this, options);
    }

    // ─── Internals ───────────────────────────────────────────────────────

    /**
     * Common preconditions for registration variants.
     * @throws {@link SatimMissingDataError} when `_returnUrl` or `_amount` is absent.
     */
    private validateForRegister(): void {
        if (this._returnUrl === undefined) {
            throw new SatimMissingDataError("Return URL missing. Call returnUrl() to set it.");
        }
        if (this._amount === undefined) {
            throw new SatimMissingDataError("Amount missing. Call the amount() method to set it.");
        }
    }

    /**
     * Return the configured order number, or generate a random
     * 10-character base-36 one from the runtime CSPRNG.
     *
     * See {@link randomOrderNumber} for why the alphabet is base-36 rather
     * than decimal: the 36^10 space keeps accidental collisions negligible
     * across a merchant's whole order history.
     */
    private getFinalOrderNumber(): string {
        return this._orderNumber ?? randomOrderNumber();
    }

    /**
     * Thin delegate kept for legacy test access via
     * `(satim as any).validateOrderId(...)`. New code should call
     * {@link assertOrderId} directly.
     */
    private validateOrderId(orderId: string, context: string): void {
        assertOrderId(orderId, context);
    }

    /**
     * Build the form payload for registration.
     *
     * Security: strips `force_terminal_id` from user-supplied
     * `_userDefinedFields` and always sets it from the credential store.
     * User input cannot override the terminal binding (defence in depth
     * alongside the validator-time check in `assertUserField`).
     *
     * Postcondition: returns a plain object suitable for `URLSearchParams`
     * encoding. `undefined` fields are omitted by `buildBody`.
     */
    private buildData(orderNumber: string): Record<string, unknown> {
        const { [FORCE_TERMINAL_KEY]: _stripped, ...safeUserFields } = this._userDefinedFields;
        const data: Record<string, unknown> = {
            userName: this.username,
            password: this.password,
            orderNumber,
            amount: toMinorUnits(this._amount!),
            currency: this._currency,
            returnUrl: this._returnUrl,
            failUrl: this._failUrl ?? this._returnUrl,
            language: this._language,
            jsonParams: JSON.stringify({ ...safeUserFields, [FORCE_TERMINAL_KEY]: this.terminalId }),
        };
        if (this._description !== undefined) data.description = this._description;
        if (this._sessionTimeoutSecs !== undefined) data.sessionTimeoutSecs = this._sessionTimeoutSecs;
        if (this._dynamicCallbackUrl !== undefined) data.dynamicCallbackUrl = this._dynamicCallbackUrl;
        if (this._idempotencyKey !== undefined) data.externalRequestId = this._idempotencyKey;
        return data;
    }

    /**
     * Shared implementation for `register` and `registerPreAuth`.
     *
     * Validates prerequisites, generates/uses the order number, builds
     * the payload, and dispatches with retry enabled iff an idempotency
     * key is set.
     */
    private async registerAt(endpoint: "/register.do" | "/registerPreAuth.do"): Promise<RegisterResponse> {
        this.validateForRegister();
        const orderNumber = this.getFinalOrderNumber();
        const data = this.buildData(orderNumber);
        // Idempotency key makes retries safe — enable them automatically.
        const retryable = this._idempotencyKey !== undefined;
        const result = await this.httpClientService.handleApiRequest<RegisterOrderResponse>(
            endpoint, data, { retryable },
        );
        return new RegisterResponse(result);
    }

    /**
     * Shared implementation for `safeRegister` and `safeRegisterPreAuth`.
     *
     * Derives the idempotency key + order number from `merchantRef`,
     * sets them on a clone, dispatches, and translates `ErrorCode: "1"`
     * (duplicate order) into {@link SatimDuplicateOrderError}.
     */
    private async safeRegisterAt(merchantRef: string, mode: "register" | "preauth"): Promise<RegisterResponse> {
        if (!merchantRef || !merchantRef.trim()) {
            throw new SatimInvalidArgumentError(`merchantRef is required for ${mode === "preauth" ? "safeRegisterPreAuth" : "safeRegister"}.`);
        }
        this.validateForRegister();
        const key = deriveIdempotencyKey({
            merchantRef, amount: this._amount!, currency: this._currency, mode,
        });
        const orderNumber = deriveOrderNumber(merchantRef, this._currency, mode);
        const configured = this.idempotencyKey(key).orderNumber(orderNumber);
        try {
            return mode === "preauth"
                ? await configured.registerPreAuth()
                : await configured.register();
        } catch (err) {
            if (err instanceof SatimGatewayError && err.errorCode === "1") {
                throw new SatimDuplicateOrderError(merchantRef);
            }
            throw err;
        }
    }
}

/**
 * Primary client facade for the SATIM REST API. Wraps `HttpClientService`;
 * each method validates inputs, builds the payload, and returns a
 * `RegisterResponse`/`ConfirmResponse`.
 * Retry is enabled only for idempotent calls — `status`, and
 * `register`/`registerPreAuth` when `_idempotencyKey` is set (otherwise a
 * retry could duplicate the order) — and never for other endpoints.
 * `safeRegister*` translates `ErrorCode: "1"` into {@link SatimDuplicateOrderError}.
 * @file
 */

import { SatimConfig } from "./config.js";
import { HttpClientService, type HttpClientOptions } from "./client.js";
import {
    SatimMissingDataError, SatimInvalidArgumentError,
    SatimDuplicateOrderError, SatimGatewayError,
    SatimInvalidCredentialsError, SatimUnexpectedResponseError,
} from "./exceptions.js";
import type { SatimCredentials, RegisterOrderResponse, ConfirmOrderResponse } from "./types.js";
import { RegisterResponse } from "./responses/register.js";
import { ConfirmResponse } from "./responses/confirm.js";
import { toMinorUnits } from "./money.js";
import { assertOrderId, assertConfirmAmount, assertRefundAmount, assertOrderNumber } from "./validation.js";
import { deriveIdempotencyKey, deriveOrderNumber } from "./idempotency.js";
import { randomOrderNumber } from "./crypto.js";
import { WebhookHandler, type WebhookHandlerOptions } from "./webhook/handler.js";

/** Whether a given gateway operation is open to the configured terminal. */
export type CapabilityState = "available" | "not_permitted" | "unavailable" | "unknown";

/** Result of {@link Satim.checkCapabilities}. */
export interface SatimCapabilities {
    /** `false` when the gateway rejected the credentials outright. */
    credentialsValid: boolean;
    operations: {
        status: CapabilityState;
        statusExtended: CapabilityState;
        deposit: CapabilityState;
        refund: CapabilityState;
        reverse: CapabilityState;
        decline: CapabilityState;
    };
}

/** Key always stripped from caller-supplied `jsonParams` then set from the credential store. */
const FORCE_TERMINAL_KEY = "force_terminal_id";

/**
 * SATIM REST API client.
 *
 * Credentials are bound to a module-private `WeakMap` entry (see
 * {@link SatimConfig.initFromCredentials}). Every fluent setter returns a
 * clone, so instances are safe to share across concurrent requests.
 */
export class Satim extends SatimConfig {
    protected httpClientService: HttpClientService;
    /** `true` when the caller passed an `HttpClientService` instance — `setTestMode` will not rebuild it. */
    private readonly _hasCustomHttpClient: boolean;
    /** Options remembered so `setTestMode` can rebuild the default transport. */
    private readonly _httpClientOptions: HttpClientOptions | undefined;

    /**
     * @param credentials Merchant credentials from CIBWeb, validated
     *        against {@link SatimCredentials}.
     * @param httpClientService Pre-built `HttpClientService`, or options
     *        for the default transport.
     * @throws {@link SatimInvalidArgumentError} / {@link SatimMissingDataError}
     *         on invalid credentials or `timeoutMs`.
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
     * Rebuilds the default HTTP client when `testMode` changes (the base
     * URL is baked in at construction). A caller-injected client is
     * preserved as-is.
     * @returns Clone with `testMode` set and, if applicable, a fresh
     *          default `HttpClientService`.
     */
    public override setTestMode(isEnabled: boolean): this {
        const clone = super.setTestMode(isEnabled);
        if (!clone._hasCustomHttpClient) {
            clone.httpClientService = new HttpClientService(clone.testMode, clone._httpClientOptions);
        }
        return clone;
    }

    /**
     * Also copies transport state (`httpClientService` and two private
     * flags) that the base `SatimConfig.clone` doesn't know about. Casts
     * to `any` since those fields are `readonly` outside this method.
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
     * Register a new payment order via `/register.do`. Requires
     * `_returnUrl` and `_amount` set; retried automatically iff
     * `_idempotencyKey` is set.
     * @throws {@link SatimMissingDataError} when required fields are absent.
     * @throws {@link SatimGatewayError} on `ErrorCode` 1, 3, 4, 7.
     * @throws {@link SatimInvalidCredentialsError} on `ErrorCode` 5.
     * @throws {@link SatimUnexpectedResponseError} on transport failures or
     *         other non-zero error codes.
     */
    public register(): Promise<RegisterResponse> {
        return this.registerAt("/register.do");
    }

    /**
     * Register a pre-authorization (fund hold) via `/registerPreAuth.do`.
     * Capture later via `confirm()` or release via `reverseOrder()`.
     *
     * Same preconditions, retry semantics, and exceptions as {@link register}.
     */
    public registerPreAuth(): Promise<RegisterResponse> {
        return this.registerAt("/registerPreAuth.do");
    }

    // ─── Order management endpoints ──────────────────────────────────────

    /**
     * Confirm (deposit) a payment via `/public/acknowledgeTransaction.do`.
     * Not retried — could double-fire side effects. Auto-verifies the
     * amount (defends against partial-capture manipulation); this is the
     * only safe confirmation path and must run server-side only, never
     * from the customer's browser.
     * @throws {@link SatimInvalidArgumentError} on malformed `orderId` or `expectedAmount`.
     * @throws {@link SatimUnexpectedResponseError} on amount mismatch.
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
     * Query order status via `/getOrderStatus.do`. Idempotent — retried
     * automatically on transient failures, and concurrent calls for the
     * same `orderId` are collapsed into one in-flight request.
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
     * Query multiple orders in parallel. Duplicate `orderId`s are
     * deduplicated by `HttpClientService`, not re-requested. Rejects with
     * the first error; other in-flight requests still run to completion.
     * @throws {@link SatimInvalidArgumentError} on any malformed `orderId`.
     * @throws Any gateway/transport exception per `handleApiRequest`.
     */
    public statusAll(orderIds: string[]): Promise<ConfirmResponse[]> {
        return Promise.all(orderIds.map(id => this.status(id)));
    }

    /**
     * Pre-warms the TCP+TLS connection to the gateway, avoiding the
     * handshake cost (~50-200ms) on the first real request. Sends a
     * probe to `/getOrderStatus.do` with a known-unknown order ID
     * (expects `ErrorCode` 6). Never throws — a failed probe is
     * silently discarded.
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
     * Refund a captured payment via `/refund.do`. Not retried — a
     * retry could double-refund.
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
     * Void a pre-settlement payment via `/reverse.do`. Cheaper than
     * refund — cancels before acquirer settlement, avoiding fees.
     * Applies to status `1` (pre-authorized) and `2` (deposited,
     * unsettled). Not retried.
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

    /**
     * Capture a pre-authorized order via `/deposit.do`.
     *
     * This is the second phase of a two-phase payment and the only way to
     * take money that {@link registerPreAuth} put on hold.
     *
     * @param amount Major units to capture. Omit to capture the full order
     *        (sent as `amount=0`, which BPC defines as the whole amount).
     *        A smaller value performs a partial capture, and the gateway
     *        may allow further captures afterwards.
     *
     * Retry: disabled. A repeated capture would take the money twice.
     *
     * @throws {@link SatimInvalidArgumentError} on a malformed `orderId`
     *         or a non-positive / over-precise `amount`.
     */
    public async deposit(orderId: string, amount?: number): Promise<ConfirmResponse> {
        assertOrderId(orderId, "deposit");
        if (amount !== undefined) assertRefundAmount(amount);
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/deposit.do",
            {
                userName: this.username, password: this.password, orderId,
                amount: amount === undefined ? 0 : toMinorUnits(amount),
                currency: this._currency, language: this._language,
            },
            { retryable: false },
        );
        return new ConfirmResponse(result);
    }

    /**
     * Cancel an order that has not been paid, via `/decline.do`.
     *
     * Only works while the order is incomplete; the gateway moves it to
     * `DECLINED`. Use this to release an abandoned checkout rather than
     * leaving it to expire.
     *
     * Both identifiers are required — the gateway's `orderId` and your own
     * `orderNumber` — because `decline.do` marks both mandatory.
     *
     * Retry: disabled.
     *
     * @throws {@link SatimInvalidArgumentError} on malformed identifiers.
     */
    public async decline(orderId: string, orderNumber: string): Promise<ConfirmResponse> {
        assertOrderId(orderId, "decline");
        const number = assertOrderNumber(orderNumber);
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/decline.do",
            {
                userName: this.username, password: this.password,
                orderId, orderNumber: number, language: this._language,
            },
            { retryable: false },
        );
        return new ConfirmResponse(result);
    }

    /**
     * Query order status via `/getOrderStatusExtended.do`.
     *
     * BPC treats this, not `/getOrderStatus.do`, as the authoritative way
     * to find out whether a payment succeeded: a request can be processed
     * successfully and still describe a failed payment. It also returns
     * more detail than {@link status}.
     *
     * Idempotent, so retried and de-duplicated like {@link status}.
     *
     * @throws {@link SatimInvalidArgumentError} on a malformed `orderId`.
     */
    public async statusExtended(orderId: string): Promise<ConfirmResponse> {
        assertOrderId(orderId, "extended status check");
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/getOrderStatusExtended.do",
            { userName: this.username, password: this.password, orderId, language: this._language },
        );
        return new ConfirmResponse(result);
    }

    /**
     * Discover which order-management operations this terminal may call.
     *
     * SATIM enables BPC's operations per merchant, so `deposit`, `refund`,
     * `reverse` and `decline` may each be deployed but closed to you. That
     * is otherwise only discoverable by asking your bank, or by watching a
     * real refund fail in production.
     *
     * Each operation is probed with a sentinel order id that cannot exist.
     * Nothing is mutated: there is no order to act on, so the gateway can
     * only answer with a permission verdict.
     *
     * - `"available"` — the gateway accepted the call and complained about
     *   the unknown order, which means the operation itself is open to you.
     * - `"not_permitted"` — access denied while credentials are otherwise
     *   good, so the operation is closed to this terminal. Ask your bank.
     * - `"unavailable"` — the endpoint is not deployed at all (HTTP 404).
     * - `"unknown"` — the gateway answered in a way this probe cannot
     *   classify; treat as inconclusive rather than as a verdict.
     *
     * `credentialsValid` is resolved first from `/getOrderStatus.do`. When
     * it is `false` every other result is `"unknown"`, because a bad
     * password denies everything and tells you nothing about entitlement.
     *
     * Intended for a startup check or a deployment smoke test, not per
     * request: it costs one round trip per operation.
     */
    public async checkCapabilities(): Promise<SatimCapabilities> {
        const SENTINEL = "00000000-0000-0000-0000-000000000000";
        const base = { userName: this.username, password: this.password, language: this._language };

        const probe = async (endpoint: string, extra: Record<string, unknown> = {}) => {
            try {
                await this.httpClientService.handleApiRequest(
                    endpoint, { ...base, orderId: SENTINEL, ...extra }, { retryable: false },
                );
                return "available" as const;
            } catch (err) {
                // errorCode 6 "unknown order" is the signal we want: the
                // gateway processed the call and only objected to the order.
                if (err instanceof SatimInvalidArgumentError) return "available" as const;
                if (err instanceof SatimGatewayError) return "available" as const;
                if (err instanceof SatimInvalidCredentialsError) return "denied" as const;
                if (err instanceof SatimUnexpectedResponseError && err.httpStatus === 404) {
                    return "unavailable" as const;
                }
                return "unknown" as const;
            }
        };

        const control = await probe("/getOrderStatus.do");
        const credentialsValid = control !== "denied";

        const resolve = (verdict: Awaited<ReturnType<typeof probe>>): CapabilityState => {
            if (!credentialsValid) return "unknown";
            if (verdict === "denied") return "not_permitted";
            return verdict;
        };

        const [statusExtended, deposit, refund, reverse, decline] = await Promise.all([
            probe("/getOrderStatusExtended.do"),
            probe("/deposit.do", { amount: 0, currency: this._currency }),
            probe("/refund.do", { amount: 1, currency: this._currency }),
            probe("/reverse.do", { currency: this._currency }),
            probe("/decline.do", { orderNumber: "0" }),
        ]);

        return {
            credentialsValid,
            operations: {
                status: resolve(control),
                statusExtended: resolve(statusExtended),
                deposit: resolve(deposit),
                refund: resolve(refund),
                reverse: resolve(reverse),
                decline: resolve(decline),
            },
        };
    }

    // ─── Safe (idempotent) registration ──────────────────────────────────

    /**
     * Register with automatic idempotency: derives a key + order number
     * from `merchantRef`, then calls {@link register} (safe to retry —
     * the gateway dedupes on the derived key). On `ErrorCode: "1"`
     * (duplicate order, conflicting amount/currency), throws
     * {@link SatimDuplicateOrderError} instead.
     * @throws {@link SatimInvalidArgumentError} when `merchantRef` is empty.
     * @throws {@link SatimMissingDataError} when prerequisites missing.
     * @throws {@link SatimDuplicateOrderError} on conflicting prior registration.
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
     * It re-verifies state server-to-server via `confirm()` on every
     * callback. See [`webhook/README.md`](./webhook/README.md) for the flow.
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
     * Returns the configured order number, or a random 10-char base-36
     * one (see {@link randomOrderNumber}) — the 36^10 space keeps
     * collisions negligible across a merchant's order history.
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
     * Builds the form payload for registration.
     *
     * Security: strips `force_terminal_id` from user-supplied
     * `_userDefinedFields` and always re-sets it from the credential
     * store, so user input cannot override the terminal binding
     * (defence in depth alongside `assertUserField`).
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
     * Shared implementation for `register` and `registerPreAuth`. Retry
     * is enabled iff `_idempotencyKey` is set (safe to retry only then).
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
     * Shared implementation for `safeRegister`/`safeRegisterPreAuth`:
     * derives the idempotency key + order number from `merchantRef`,
     * dispatches, and translates `ErrorCode: "1"` into
     * {@link SatimDuplicateOrderError}.
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

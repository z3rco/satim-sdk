/**
 * Primary client facade for the SATIM gateway.
 *
 * Exposes register, confirm, status, refund, registerPreAuth, reverseOrder,
 * and webhook handlers. Inherits the immutable fluent configuration API
 * from SatimConfig and adds the HTTP transport layer.
 * @file
 */

import { randomInt } from "node:crypto";
import { SatimConfig } from "./config";
import { HttpClientService, type HttpClientOptions } from "./client";
import {
    SatimMissingDataError, SatimInvalidArgumentError,
    SatimDuplicateOrderError, SatimGatewayError,
} from "./exceptions";
import type { SatimCredentials, RegisterOrderResponse, ConfirmOrderResponse } from "./types";
import { RegisterResponse } from "./responses/register";
import { ConfirmResponse } from "./responses/confirm";
import { toMinorUnits } from "./money";
import { assertOrderId, assertConfirmAmount, assertRefundAmount } from "./validation";
import { deriveIdempotencyKey, deriveOrderNumber } from "./idempotency";
import { WebhookHandler, type WebhookHandlerOptions } from "./webhook/handler";

const FORCE_TERMINAL_KEY = "force_terminal_id";

/**
 * SATIM REST API client. Supports register, confirm, status, refund,
 * pre-authorization, reversal, and zero-trust webhooks.
 */
export class Satim extends SatimConfig {
    protected httpClientService: HttpClientService;
    private readonly _hasCustomHttpClient: boolean;
    private readonly _httpClientOptions: HttpClientOptions | undefined;

    /**
     * @param credentials Merchant credentials from CIBWeb.
     * @param httpClientService Pre-built HttpClientService, or HttpClientOptions
     *                          for the default transport.
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

    /** Override to rebuild the default HTTP client when testMode changes. */
    public override setTestMode(isEnabled: boolean): this {
        const clone = super.setTestMode(isEnabled);
        if (!clone._hasCustomHttpClient) {
            clone.httpClientService = new HttpClientService(clone.testMode, clone._httpClientOptions);
        }
        return clone;
    }

    /** Override to copy transport state alongside config state. */
    protected override clone(): this {
        const c = super.clone();
        c.httpClientService = this.httpClientService;
        (c as any)._hasCustomHttpClient = this._hasCustomHttpClient;
        (c as any)._httpClientOptions = this._httpClientOptions;
        return c;
    }

    // ─── Registration endpoints ──────────────────────────────────────────

    /** Register a payment via /register.do. */
    public register(): Promise<RegisterResponse> {
        return this.registerAt("/register.do");
    }

    /** Register a fund hold via /registerPreAuth.do; capture later via confirm(). */
    public registerPreAuth(): Promise<RegisterResponse> {
        return this.registerAt("/registerPreAuth.do");
    }

    // ─── Order management endpoints ──────────────────────────────────────

    /**
     * Confirm (deposit) a payment via /confirmOrder.do.
     *
     * Amount verification runs automatically on success. For non-success
     * states the response is returned without amount checks so the caller
     * can inspect the failure reason via status predicates.
     *
     * @param orderId Identifier from register().
     * @param expectedAmount Major-unit amount; verified on success.
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

    /** Query order status via /getOrderStatus.do. Idempotent — auto-retries on transient errors. */
    public async status(orderId: string): Promise<ConfirmResponse> {
        assertOrderId(orderId, "status check");
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/getOrderStatus.do",
            { userName: this.username, password: this.password, orderId, language: this._language },
        );
        return new ConfirmResponse(result);
    }

    /** Refund a captured payment via /refund.do. Never auto-retries. */
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

    /** Void a pre-settlement payment via /reverse.do. Cheaper than refund — no acquirer fees. */
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
     * Register with automatic idempotency. Deterministic key + order number
     * derived from merchantRef — safe to retry.
     *
     * @param merchantRef Stable internal order/cart/invoice ID.
     * @throws SatimDuplicateOrderError when an existing order conflicts
     *         (e.g. different amount under the same merchantRef).
     */
    public safeRegister(merchantRef: string): Promise<RegisterResponse> {
        return this.safeRegisterAt(merchantRef, "register");
    }

    /** Pre-authorization variant of safeRegister. */
    public safeRegisterPreAuth(merchantRef: string): Promise<RegisterResponse> {
        return this.safeRegisterAt(merchantRef, "preauth");
    }

    // ─── Webhook ─────────────────────────────────────────────────────────

    /** Build a zero-trust webhook handler that re-verifies state server-to-server. */
    public createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler {
        return new WebhookHandler(this, options);
    }

    // ─── Internals ───────────────────────────────────────────────────────

    private validateForRegister(): void {
        if (this._returnUrl === undefined) {
            throw new SatimMissingDataError("Return URL missing. Call returnUrl() to set it.");
        }
        if (this._amount === undefined) {
            throw new SatimMissingDataError("Amount missing. Call the amount() method to set it.");
        }
    }

    private getFinalOrderNumber(): string {
        return this._orderNumber ?? String(randomInt(1_000_000_000, 10_000_000_000));
    }

    /** Thin delegate kept for legacy test access via `(satim as any).validateOrderId`. */
    private validateOrderId(orderId: string, context: string): void {
        assertOrderId(orderId, context);
    }

    /** Build request body. Strips force_terminal_id from user fields, always sets the real one. */
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

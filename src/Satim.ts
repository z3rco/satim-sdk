import { randomInt } from "node:crypto";
import { SatimConfig } from "./config";
import { HttpClientService } from "./client";
import type { HttpClientOptions } from "./client";
import {
    SatimMissingDataError,
    SatimInvalidArgumentError,
    SatimDuplicateOrderError,
    SatimGatewayError,
} from "./exceptions";
import type { SatimCredentials, RegisterOrderResponse, ConfirmOrderResponse } from "./types";
import { RegisterResponse, ConfirmResponse } from "./responses";
import { toMinorUnits, MAX_SAFE_AMOUNT, hasSubCentimePrecision, deriveIdempotencyKey, deriveOrderNumber } from "./utils";
import { WebhookHandler } from "./webhook";
import type { WebhookHandlerOptions } from "./webhook";

/**
 * Primary client for the SATIM payment gateway.
 *
 * Provides an immutable, stateless fluent interface to register payments, confirm orders,
 * query status, issue refunds, and perform pre-authorizations and reversals
 * against the SATIM REST API (powered by BPC Group).
 */
export class Satim extends SatimConfig {
    protected httpClientService: HttpClientService;
    private readonly _hasCustomHttpClient: boolean;
    private readonly _httpClientOptions: HttpClientOptions | undefined;

    /**
     * @param credentials       - Merchant credentials from CIBWeb.
     * @param httpClientService - Optional injected HTTP client (useful for testing).
     *                            Pass an {@link HttpClientOptions} object instead to
     *                            configure timeout, retries, and the circuit breaker
     *                            without constructing the client manually.
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
     * Override to recreate the internal HTTP client when the environment changes.
     * Preserves a custom-injected httpClientService — only replaces the default one.
     */
    public override setTestMode(isEnabled: boolean): this {
        const clone = super.setTestMode(isEnabled);
        if (!clone._hasCustomHttpClient) {
            clone.httpClientService = new HttpClientService(clone.testMode, clone._httpClientOptions);
        }
        return clone;
    }

    /**
     * Override to include httpClientService and custom-client flag in the explicit clone.
     */
    protected override clone(): this {
        const cloned = super.clone();
        cloned.httpClientService = this.httpClientService;
        (cloned as any)._hasCustomHttpClient = this._hasCustomHttpClient;
        (cloned as any)._httpClientOptions = this._httpClientOptions;
        return cloned;
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    private getFinalOrderNumber(): string {
        if (this._orderNumber !== undefined) {
            return this._orderNumber;
        }
        return String(randomInt(1_000_000_000, 10_000_000_000));
    }

    private validateForRegister(): void {
        if (this._returnUrl === undefined) {
            throw new SatimMissingDataError("Return URL missing. Call returnUrl() to set it.");
        }
        if (this._amount === undefined) {
            throw new SatimMissingDataError("Amount missing. Call the amount() method to set it.");
        }
    }

    /**
     * Validate that an order ID is a non-empty, non-whitespace string.
     */
    private validateOrderId(orderId: string, context: string): void {
        if (typeof orderId !== "string") {
            throw new SatimInvalidArgumentError(
                `Order ID must be a string for ${context}, got ${typeof orderId}.`,
            );
        }
        if (!orderId || !orderId.trim()) {
            throw new SatimInvalidArgumentError(`Order ID is required for ${context}`);
        }
        if (orderId.length > 128 || !/^[a-zA-Z0-9\-]+$/.test(orderId)) {
            throw new SatimInvalidArgumentError(`Invalid order ID format for ${context}. Must be alphasatim-module/hyphens, max 128 chars.`);
        }
    }

    private buildData(finalOrderNumber: string): Record<string, unknown> {
        // Explicitly strip force_terminal_id from user input to prevent terminal ID injection
        const { force_terminal_id: _, ...safeUserFields } = this._userDefinedFields;
        const additionalData: Record<string, string> = {
            ...safeUserFields,
            force_terminal_id: this.terminalId,
        };

        const data: Record<string, unknown> = {
            userName: this.username,
            password: this.password,
            orderNumber: finalOrderNumber,
            amount: toMinorUnits(this._amount!),
            currency: this._currency,
            returnUrl: this._returnUrl,
            failUrl: this._failUrl ?? this._returnUrl,
            language: this._language,
            jsonParams: JSON.stringify(additionalData),
        };

        if (this._description !== undefined) {
            data.description = this._description;
        }
        if (this._sessionTimeoutSecs !== undefined) {
            data.sessionTimeoutSecs = this._sessionTimeoutSecs;
        }
        if (this._dynamicCallbackUrl !== undefined) {
            data.dynamicCallbackUrl = this._dynamicCallbackUrl;
        }
        if (this._idempotencyKey !== undefined) {
            data.externalRequestId = this._idempotencyKey;
        }

        return data;
    }

    // ─── Registration endpoints ──────────────────────────────────────────

    /**
     * Register a new payment order via `/register.do`.
     *
     * @throws SatimMissingDataError        if required fields are absent.
     * @throws SatimUnexpectedResponseError if the gateway returns a non-zero errorCode.
     */
    public async register(): Promise<RegisterResponse> {
        this.validateForRegister();
        const finalOrderNumber = this.getFinalOrderNumber();
        const data = this.buildData(finalOrderNumber);

        // Idempotency key makes retries safe — enable them automatically
        const retryable = this._idempotencyKey !== undefined;

        const result = await this.httpClientService.handleApiRequest<RegisterOrderResponse>(
            "/register.do",
            data,
            { retryable },
        );

        return new RegisterResponse(result);
    }

    /**
     * Register a pre-authorization (fund hold) via `/registerPreAuth.do`.
     *
     * Holds the specified amount on the customer's card without capturing.
     * Useful for deposits, rentals, or delayed-capture flows.
     *
     * Confirmed active on the SATIM test gateway.
     *
     * @throws SatimMissingDataError        if required fields are absent.
     * @throws SatimUnexpectedResponseError if the gateway returns a non-zero errorCode.
     */
    public async registerPreAuth(): Promise<RegisterResponse> {
        this.validateForRegister();
        const finalOrderNumber = this.getFinalOrderNumber();
        const data = this.buildData(finalOrderNumber);

        const retryable = this._idempotencyKey !== undefined;

        const result = await this.httpClientService.handleApiRequest<RegisterOrderResponse>(
            "/registerPreAuth.do",
            data,
            { retryable },
        );

        return new RegisterResponse(result);
    }

    // ─── Order management endpoints ──────────────────────────────────────

    /**
     * Confirm (deposit) a payment via `/confirmOrder.do`.
     *
     * Call this when the customer is redirected back to your returnUrl
     * to finalize and verify the transaction status.
     *
     * Amount verification is performed automatically **only when the payment
     * is successful** (OrderStatus 2). For failed/cancelled/expired payments,
     * the response is returned without amount checks so the caller can inspect
     * the real failure reason via status predicates.
     *
     * @param orderId        - The order identifier returned by register().
     * @param expectedAmount - The expected payment amount in major currency units.
     *                         Verified against the gateway response on success to
     *                         prevent partial-payment manipulation.
     * @throws SatimInvalidArgumentError if orderId is empty or expectedAmount is invalid.
     * @throws Error if the payment succeeded but the captured amount does not match.
     */
    public async confirm(orderId: string, expectedAmount: number): Promise<ConfirmResponse> {
        this.validateOrderId(orderId, "confirmation");
        if (typeof expectedAmount !== "number") {
            throw new SatimInvalidArgumentError(
                `expectedAmount must be a number, got ${Array.isArray(expectedAmount) ? "array" : typeof expectedAmount}.`,
            );
        }
        if (expectedAmount <= 0 || !Number.isFinite(expectedAmount)) {
            throw new SatimInvalidArgumentError("expectedAmount must be a finite positive number.");
        }
        if (expectedAmount > MAX_SAFE_AMOUNT) {
            throw new SatimInvalidArgumentError("expectedAmount exceeds safe precision for minor-unit conversion.");
        }
        if (hasSubCentimePrecision(expectedAmount)) {
            throw new SatimInvalidArgumentError("expectedAmount must not have more than 2 decimal places.");
        }

        const data = {
            userName: this.username,
            password: this.password,
            mdOrder: orderId,
            language: this._language,
        };

        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/public/acknowledgeTransaction.do",
            data,
            { retryable: false },
        );
        const response = new ConfirmResponse(result);
        if (response.isSuccessful()) {
            response.verifyAmount(expectedAmount);
        }

        return response;
    }

    /**
     * Query the current status of an order via `/getOrderStatus.do`.
     *
     * @param orderId - The order identifier returned by register().
     * @throws SatimInvalidArgumentError if orderId is empty.
     */
    public async status(orderId: string): Promise<ConfirmResponse> {
        this.validateOrderId(orderId, "status check");

        const data = {
            userName: this.username,
            password: this.password,
            orderId,
            language: this._language,
        };

        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/getOrderStatus.do",
            data,
        );
        return new ConfirmResponse(result);
    }

    /**
     * Issue a refund for a previously captured payment via `/refund.do`.
     *
     * @param orderId - The order identifier.
     * @param amount  - Refund amount in major currency units.
     * @throws SatimInvalidArgumentError if orderId is empty or amount is invalid.
     */
    public async refund(orderId: string, amount: number): Promise<ConfirmResponse> {
        this.validateOrderId(orderId, "refund");
        if (typeof amount !== "number") {
            throw new SatimInvalidArgumentError(
                `Amount must be a number, got ${Array.isArray(amount) ? "array" : typeof amount}.`,
            );
        }
        if (amount <= 0 || !Number.isFinite(amount)) {
            throw new SatimInvalidArgumentError("Amount must be a finite positive number");
        }
        if (amount > MAX_SAFE_AMOUNT) {
            throw new SatimInvalidArgumentError("Amount exceeds safe precision for minor-unit conversion.");
        }
        if (hasSubCentimePrecision(amount)) {
            throw new SatimInvalidArgumentError("Amount must not have more than 2 decimal places.");
        }
        const minorAmount = toMinorUnits(amount);
        if (minorAmount < 1) {
            throw new SatimInvalidArgumentError("Amount too small: must convert to at least 1 minor unit (centime/cent).");
        }

        const data = {
            userName: this.username,
            password: this.password,
            orderId,
            amount: minorAmount,
            currency: this._currency,
            language: this._language,
        };

        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/refund.do",
            data,
            { retryable: false },
        );
        return new ConfirmResponse(result);
    }

    /**
     * Reverse (void) a payment before batch settlement via `/reverse.do`.
     *
     * Unlike a refund, a reversal cancels the authorization before the
     * acquirer settles the transaction, avoiding processing fees.
     *
     * Confirmed active on the SATIM test gateway.
     *
     * @param orderId - The order identifier.
     * @throws SatimInvalidArgumentError if orderId is empty.
     */
    public async reverseOrder(orderId: string): Promise<ConfirmResponse> {
        this.validateOrderId(orderId, "reversal");

        const data = {
            userName: this.username,
            password: this.password,
            orderId,
            language: this._language,
        };

        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/reverse.do",
            data,
            { retryable: false },
        );
        return new ConfirmResponse(result);
    }

    // ─── Safe registration (idempotent) ────────────────────────────────

    /**
     * Register a payment with automatic idempotency, deterministic order
     * numbers, and retry-safe behavior. One call, bulletproof.
     *
     * Internally:
     * 1. Derives a deterministic idempotency key from `merchantRef` + amount + currency
     * 2. Derives a stable 10-digit order number from `merchantRef`
     * 3. Sends both to SATIM as `externalRequestId` and `orderNumber`
     * 4. Enables retries (safe because of the idempotency key)
     * 5. If SATIM returns ErrorCode "1" (duplicate order), throws
     *    `SatimDuplicateOrderError` with the `merchantRef` so you can
     *    recover via `status()` with the original orderId.
     *
     * @param merchantRef - Your internal order/cart/invoice ID. Same ref
     *                      always produces the same SATIM order.
     * @throws SatimMissingDataError if amount or returnUrl is not set.
     * @throws SatimDuplicateOrderError if the order was already registered
     *         (and the idempotency key did not match — e.g. different amount).
     */
    public async safeRegister(merchantRef: string): Promise<RegisterResponse> {
        if (!merchantRef || !merchantRef.trim()) {
            throw new SatimInvalidArgumentError("merchantRef is required for safeRegister.");
        }
        this.validateForRegister();

        const key = deriveIdempotencyKey({
            merchantRef,
            amount: this._amount!,
            currency: this._currency,
        });
        const stableOrderNumber = deriveOrderNumber(merchantRef, this._currency);

        const configured = this
            .idempotencyKey(key)
            .orderNumber(stableOrderNumber);

        try {
            return await configured.register();
        } catch (err) {
            if (err instanceof SatimGatewayError && err.errorCode === "1") {
                throw new SatimDuplicateOrderError(merchantRef);
            }
            throw err;
        }
    }

    /**
     * Pre-authorization variant of `safeRegister()`.
     *
     * Same idempotency guarantees as `safeRegister()` but registers a
     * fund hold instead of a full capture.
     *
     * @param merchantRef - Your internal order/cart/invoice ID.
     * @throws SatimMissingDataError if amount or returnUrl is not set.
     * @throws SatimDuplicateOrderError if the order was already registered.
     */
    public async safeRegisterPreAuth(merchantRef: string): Promise<RegisterResponse> {
        if (!merchantRef || !merchantRef.trim()) {
            throw new SatimInvalidArgumentError("merchantRef is required for safeRegisterPreAuth.");
        }
        this.validateForRegister();

        const key = deriveIdempotencyKey({
            merchantRef,
            amount: this._amount!,
            currency: this._currency,
            mode: "preauth",
        });
        const stableOrderNumber = deriveOrderNumber(merchantRef, this._currency, "preauth");

        const configured = this
            .idempotencyKey(key)
            .orderNumber(stableOrderNumber);

        try {
            return await configured.registerPreAuth();
        } catch (err) {
            if (err instanceof SatimGatewayError && err.errorCode === "1") {
                throw new SatimDuplicateOrderError(merchantRef);
            }
            throw err;
        }
    }

    // ─── Webhook handling ───────────────────────────────────────────────

    /**
     * Create a zero-trust webhook handler for SATIM callbacks and redirects.
     *
     * The handler **never trusts the callback payload**. Every callback
     * triggers a server-to-server `confirm()` call to verify the payment
     * state and amount directly with the SATIM gateway.
     *
     * This is strictly stronger than HMAC signature verification because:
     * - Signatures prove origin but not current state (vulnerable to replays)
     * - This handler fetches live authoritative state on every callback
     * - Amount verification is automatic — partial payment attacks are impossible
     *
     * Built-in protections: replay rejection, rate limiting, amount verification,
     * orderId sanitization, pluggable persistence for distributed deployments.
     *
     * @example
     * ```typescript
     * const webhook = satim.createWebhookHandler({
     *     onResolveAmount: async (orderId) => {
     *         const order = await db.orders.findByPaymentId(orderId);
     *         return order?.totalAmount;
     *     },
     * });
     *
     * app.post("/webhooks/satim", async (req) => {
     *     const result = await webhook.verify(req.body);
     *     if (!result) return new Response("Rejected", { status: 400 });
     *     if (result.duplicate) return new Response("OK", { status: 200 });
     *     if (result.response.isSuccessful()) {
     *         await fulfillOrder(result.orderId);
     *     }
     *     return new Response("OK", { status: 200 });
     * });
     * ```
     */
    public createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler {
        return new WebhookHandler(this, options);
    }
}

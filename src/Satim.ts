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

export type CapabilityState = "available" | "not_permitted" | "unavailable" | "unknown";

export interface SatimCapabilities {

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

const FORCE_TERMINAL_KEY = "force_terminal_id";

export class Satim extends SatimConfig {
    protected httpClientService: HttpClientService;

    private readonly _hasCustomHttpClient: boolean;

    private readonly _httpClientOptions: HttpClientOptions | undefined;

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

    public override setTestMode(isEnabled: boolean): this {
        const clone = super.setTestMode(isEnabled);
        if (!clone._hasCustomHttpClient) {
            clone.httpClientService = new HttpClientService(clone.testMode, clone._httpClientOptions);
        }
        return clone;
    }

    protected override clone(): this {
        const c = super.clone();
        c.httpClientService = this.httpClientService;
        (c as any)._hasCustomHttpClient = this._hasCustomHttpClient;
        (c as any)._httpClientOptions = this._httpClientOptions;
        return c;
    }

    public register(): Promise<RegisterResponse> {
        return this.registerAt("/register.do");
    }

    public registerPreAuth(): Promise<RegisterResponse> {
        return this.registerAt("/registerPreAuth.do");
    }

    public async confirm(orderId: string, expectedAmount: number): Promise<ConfirmResponse> {
        assertOrderId(orderId, "confirmation");
        assertConfirmAmount(expectedAmount);

        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/public/acknowledgeTransaction.do",
            { userName: this.username, password: this.password, mdOrder: orderId, language: this._language },
            { retryable: false },
        );
        const response = new ConfirmResponse(result);
        if (response.isSuccessful()) {
            response.verifyAmount(expectedAmount);
            // Defence in depth (mainly against a caller-supplied hostile baseUrl): the settled currency must match what we registered under.
            if (result.currency !== undefined && String(result.currency) !== this._currency) {
                throw new SatimUnexpectedResponseError(
                    `payment currency mismatch. Expected ${this._currency}, got ${String(result.currency)}`, "gateway",
                );
            }
        }
        return response;
    }

    // Unlike confirm(), this does not verify the amount — call verifyAmount() yourself if acting on the result.
    public async status(orderId: string): Promise<ConfirmResponse> {
        assertOrderId(orderId, "status check");
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/getOrderStatus.do",
            { userName: this.username, password: this.password, orderId, language: this._language },
        );
        return new ConfirmResponse(result);
    }

    public statusAll(orderIds: string[]): Promise<ConfirmResponse[]> {
        return Promise.all(orderIds.map(id => this.status(id)));
    }

    public async warmup(): Promise<void> {
        try {
            await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
                "/getOrderStatus.do",
                { userName: this.username, password: this.password, orderId: "00000000-0000-0000-0000-000000000000", language: this._language },
                { retryable: false },
            );
        } catch {  }
    }

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

    public async reverseOrder(orderId: string): Promise<ConfirmResponse> {
        assertOrderId(orderId, "reversal");
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/reverse.do",
            { userName: this.username, password: this.password, orderId, language: this._language },
            { retryable: false },
        );
        return new ConfirmResponse(result);
    }

    public async deposit(orderId: string, amount?: number): Promise<ConfirmResponse> {
        assertOrderId(orderId, "deposit");
        if (amount !== undefined) assertRefundAmount(amount);
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/deposit.do",
            {
                userName: this.username, password: this.password, orderId,
                // BPC reads amount 0 as "capture the full order".
                amount: amount === undefined ? 0 : toMinorUnits(amount),
                currency: this._currency, language: this._language,
            },
            { retryable: false },
        );
        return new ConfirmResponse(result);
    }

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

    public async statusExtended(orderId: string): Promise<ConfirmResponse> {
        assertOrderId(orderId, "extended status check");
        const result = await this.httpClientService.handleApiRequest<ConfirmOrderResponse>(
            "/getOrderStatusExtended.do",
            { userName: this.username, password: this.password, orderId, language: this._language },
        );
        return new ConfirmResponse(result);
    }

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

                // errorCode 6 (unknown order) means the call was accepted — the operation is open to us.
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

    public safeRegister(merchantRef: string): Promise<RegisterResponse> {
        return this.safeRegisterAt(merchantRef, "register");
    }

    public safeRegisterPreAuth(merchantRef: string): Promise<RegisterResponse> {
        return this.safeRegisterAt(merchantRef, "preauth");
    }

    public createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler {
        return new WebhookHandler(this, options);
    }

    private validateForRegister(): void {
        if (this._returnUrl === undefined) {
            throw new SatimMissingDataError("Return URL missing. Call returnUrl() to set it.");
        }
        if (this._amount === undefined) {
            throw new SatimMissingDataError("Amount missing. Call the amount() method to set it.");
        }
    }

    private getFinalOrderNumber(): string {
        return this._orderNumber ?? randomOrderNumber();
    }

    private validateOrderId(orderId: string, context: string): void {
        assertOrderId(orderId, context);
    }

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
            // force_terminal_id is stripped from caller fields and set from the credential store: no terminal-ID injection.
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

        // Retry registration only with an idempotency key, else a retry could duplicate the order.
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
            // Gateway "duplicate order" -> typed error so callers recover via status(originalOrderId).
            if (err instanceof SatimGatewayError && err.errorCode === "1") {
                throw new SatimDuplicateOrderError(merchantRef);
            }
            throw err;
        }
    }
}

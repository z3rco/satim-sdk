/**
 * Supported payment page languages.
 * - FR: French (default)
 * - AR: Arabic
 * - EN: English
 */
export type Language = "FR" | "AR" | "EN";

/**
 * ISO 4217 satim-module currency codes supported by the SATIM gateway.
 * - 012: Algerian Dinar (DZD)
 * - 840: US Dollar (USD)
 * - 978: Euro (EUR)
 */
export type CurrencyCode = "012" | "840" | "978";

/** Credentials required to authenticate with the SATIM API. */
export interface SatimCredentials {
    /** Merchant username provided by CIBWeb. */
    username: string;
    /** Merchant password provided by CIBWeb. */
    password: string;
    /** Terminal identifier assigned to the merchant. */
    terminalId: string;
}

/** Response returned by the /register.do and /registerPreAuth.do endpoints. */
export interface RegisterOrderResponse {
    /** Unique identifier assigned to the registered order. */
    orderId: string;
    /** URL of the hosted payment form to which the customer should be redirected. */
    formUrl: string;
    /** Error code returned by the gateway. "0" indicates success. */
    errorCode?: string;
    /** Human-readable error description, present when errorCode is non-zero. */
    errorMessage?: string;
    [key: string]: unknown;
}

/**
 * Response returned by order management endpoints:
 * /confirmOrder.do, /getOrderStatus.do, /refund.do, /reverse.do.
 */
export interface ConfirmOrderResponse {
    /**
     * Order status code:
     * - "0": Order registered but not paid
     * - "2": Payment confirmed (deposited)
     * - "3": Authorization reversed
     * - "4": Refunded
     */
    OrderStatus?: string;
    /** Action code from the payment processor. */
    actionCode?: string;
    /** Human-readable description of the action code. */
    actionCodeDescription?: string;
    /** Error code at the order level (distinct from registration errorCode). */
    ErrorCode?: string;
    /** Error message at the order level. */
    ErrorMessage?: string;
    /** Payment amount returned by the gateway (typically in minor units). */
    amount?: number | string;
    Amount?: number | string;
    /** Order number returned by the gateway. */
    orderNumber?: string;
    OrderNumber?: string;
    /** Additional response parameters from the processor. */
    params?: {
        respCode?: string;
        respCode_desc?: string;
    };
    /** IP address of the cardholder at the time of payment. */
    Ip?: string;
    /** Name of the cardholder as returned by the issuer. */
    cardholderName?: string;
    /** Card expiration date in YYYYMM format. */
    expiration?: string;
    /** Masked card PAN (e.g. "4111**1111"). */
    Pan?: string;
    /** Authorization approval code from the issuer. */
    approvalCode?: string;
    /**
     * Actual debited amount in minor units (centimes).
     * May be less than Amount for partial pre-auth captures.
     * Mandatory in the SATIM acknowledgeTransaction.do response.
     */
    depositAmount?: number | string;
    [key: string]: unknown;
}

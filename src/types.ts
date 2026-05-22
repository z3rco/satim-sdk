/**
 * Public type definitions for the SATIM gateway.
 * @file
 */

/** Payment page languages. */
export type Language = "FR" | "AR" | "EN";

/** ISO 4217 numeric currency codes supported by SATIM. */
export type CurrencyCode = "012" | "840" | "978";

/** Merchant credentials from CIBWeb. */
export interface SatimCredentials {
    username: string;
    password: string;
    terminalId: string;
}

/** Response shape from /register.do and /registerPreAuth.do. */
export interface RegisterOrderResponse {
    orderId: string;
    formUrl: string;
    errorCode?: string;
    errorMessage?: string;
    [key: string]: unknown;
}

/**
 * Response shape from /confirmOrder.do, /getOrderStatus.do, /refund.do, /reverse.do.
 *
 * OrderStatus: 0=registered, 1=preauth, 2=deposited, 3=reversed, 4=refunded.
 */
export interface ConfirmOrderResponse {
    OrderStatus?: string;
    actionCode?: string;
    actionCodeDescription?: string;
    ErrorCode?: string;
    ErrorMessage?: string;
    amount?: number | string;
    Amount?: number | string;
    orderNumber?: string;
    OrderNumber?: string;
    params?: { respCode?: string; respCode_desc?: string };
    Ip?: string;
    cardholderName?: string;
    expiration?: string;
    Pan?: string;
    approvalCode?: string;
    depositAmount?: number | string;
    [key: string]: unknown;
}

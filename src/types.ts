/**
 * Public type definitions for the SATIM gateway integration. Adding a
 * required field here is a breaking change for callers; optional fields
 * are safe.
 * @file
 */

/**
 * Hosted payment form language.
 * - `"FR"` — French (default).
 * - `"AR"` — Arabic.
 * - `"EN"` — English.
 */
export type Language = "FR" | "AR" | "EN";

/**
 * ISO 4217 numeric currency code accepted by the SATIM gateway.
 * - `"012"` — Algerian Dinar (DZD).
 * - `"840"` — US Dollar (USD).
 * - `"978"` — Euro (EUR).
 */
export type CurrencyCode = "012" | "840" | "978";

/**
 * Merchant credentials issued by CIBWeb. Stored in a module-private
 * `WeakMap` — never appear as enumerable properties on `Satim`. Enforced
 * at construction: all three non-empty after trim; `username`/`password`
 * ≤ 100 chars, `terminalId` ≤ 16 chars (SATIM AN.100/AN.16).
 */
export interface SatimCredentials {
    username: string;
    password: string;
    terminalId: string;
}

/**
 * Response from `/register.do` and `/registerPreAuth.do`.
 *
 * On success (`errorCode` absent or `"0"`), `orderId` and `formUrl` are
 * non-empty; `formUrl` must be HTTPS on a trusted `*.satim.dz` host before
 * `redirectResponse()` will redirect. On failure, `errorCode` is set and
 * converted to a typed exception in `HttpClientService.validateApiResponse`.
 */
export interface RegisterOrderResponse {
    orderId: string;
    formUrl: string;
    errorCode?: string;
    errorMessage?: string;
    [key: string]: unknown;
}

/** Response from confirm/getOrderStatus/refund/reverse. `OrderStatus`:
 * | Value | Meaning |
 * |---|---|
 * | `"0"` | Registered, unpaid |
 * | `"1"` | Pre-authorized |
 * | `"2"` | Deposited (success) |
 * | `"3"` | Reversed |
 * | `"4"` | Refunded |
 * `Amount`/`depositAmount` are minor-unit integers; cardholder PII is
 * redacted by `getRawResponse()`. */
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

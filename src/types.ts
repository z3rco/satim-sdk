/**
 * Public type definitions for the SATIM gateway integration.
 *
 * All shapes here are part of the SDK's public API. Adding required fields
 * is a breaking change for callers; adding optional fields is safe.
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
 * Merchant credentials issued by CIBWeb. All three fields are required on
 * every outbound request and stored in the SDK's module-private `WeakMap`
 * — they never appear as enumerable instance properties on `Satim`.
 *
 * Invariants enforced at `Satim` construction:
 * - All three strings non-empty after trim.
 * - `username` and `password` ≤ 100 characters (SATIM AN.100).
 * - `terminalId` ≤ 16 characters (SATIM AN.16).
 */
export interface SatimCredentials {
    username: string;
    password: string;
    terminalId: string;
}

/**
 * Response from `/register.do` and `/registerPreAuth.do`.
 *
 * Invariants on successful registration (`errorCode === "0"` or absent):
 * - `orderId` is a non-empty string.
 * - `formUrl` is a non-empty string. Must be HTTPS on a trusted `*.satim.dz`
 *   host before `RegisterResponse.redirectResponse()` will emit a redirect.
 *
 * On failure, `errorCode` is set and the SDK converts it to a typed
 * exception in `HttpClientService.validateApiResponse`.
 */
export interface RegisterOrderResponse {
    orderId: string;
    formUrl: string;
    errorCode?: string;
    errorMessage?: string;
    [key: string]: unknown;
}

/**
 * Response from `/public/acknowledgeTransaction.do` (confirm),
 * `/getOrderStatus.do`, `/refund.do`, and `/reverse.do`.
 *
 * `OrderStatus` follows the SATIM/BPC state machine:
 *
 * | Value | Meaning |
 * |-------|---------|
 * | `"0"` | Registered, not paid (pending). |
 * | `"1"` | Pre-authorized (funds held, awaiting capture). |
 * | `"2"` | Deposited (success). |
 * | `"3"` | Reversed (authorization voided). |
 * | `"4"` | Refunded. |
 *
 * Failed-payment responses (decline, cancel, expire) typically omit
 * `OrderStatus` and carry diagnostic information in `actionCode`,
 * `params.respCode`, and `ErrorMessage`.
 *
 * `Amount` and `depositAmount` are minor-unit integers (centimes).
 * Cardholder PII (`Ip`, `Pan`, `cardholderName`, `expiration`) is redacted
 * by `ConfirmResponse.getRawResponse()` and accessible only via the typed
 * accessor methods.
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

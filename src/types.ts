export type Language = "FR" | "AR" | "EN";

export type CurrencyCode = "012" | "840" | "978";

export interface SatimCredentials {
    username: string;
    password: string;
    terminalId: string;
}

export interface RegisterOrderResponse {
    orderId: string;
    formUrl: string;
    errorCode?: string;
    errorMessage?: string;
    [key: string]: unknown;
}

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

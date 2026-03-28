/**
 * Base error class for all SATIM SDK errors.
 * All custom errors extend this class, enabling consumers
 * to catch any SDK error uniformly.
 */
export class SatimError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Thrown when a required configuration value or API response field is absent. */
export class SatimMissingDataError extends SatimError { }

/** Thrown when a method argument fails validation (e.g. invalid URL, out-of-range value). */
export class SatimInvalidArgumentError extends SatimError { }

/** Thrown when the SATIM gateway rejects the provided credentials (ErrorCode 5). */
export class SatimInvalidCredentialsError extends SatimError { }

/**
 * Safe error categories that classify the underlying cause
 * without exposing internal details (URLs, stack traces, form bodies).
 */
export type SatimErrorCategory = "network" | "timeout" | "parse" | "http" | "gateway" | "circuit_open" | "unknown";

/**
 * Thrown when the SATIM gateway returns an unexpected or malformed response.
 *
 * Exposes only a safe {@link errorCategory} classification — no raw error
 * messages, stack traces, or system codes that could leak request URLs,
 * form body contents, or internal infrastructure details.
 */
export class SatimUnexpectedResponseError extends SatimError {
    public readonly errorCategory: SatimErrorCategory;
    public readonly gatewayErrorCode?: string;
    public readonly gatewayErrorMessage?: string;
    public readonly isTimeout: boolean;
    public readonly httpStatus?: number;

    constructor(
        message: string,
        errorCategory?: SatimErrorCategory,
        gatewayDetails?: { errorCode?: string; errorMessage?: string },
        metadata?: { isTimeout?: boolean; httpStatus?: number },
    ) {
        super(message);
        this.errorCategory = errorCategory ?? "unknown";
        this.gatewayErrorCode = gatewayDetails?.errorCode;
        this.gatewayErrorMessage = gatewayDetails?.errorMessage;
        this.isTimeout = metadata?.isTimeout ?? false;
        this.httpStatus = metadata?.httpStatus;
    }
}

/**
 * Thrown when the SATIM/BPC gateway returns a well-known, typed error code.
 *
 * Known codes:
 * - `1` — Order number already registered (possible replay)
 * - `3` — Unknown currency
 * - `4` — Missing required parameter
 * - `7` — System error
 *
 * Carries the original `errorCode` and `errorMessage` from the gateway
 * for programmatic inspection.
 */
export class SatimGatewayError extends SatimError {
    public readonly errorCode: string;
    public readonly errorMessage: string;

    constructor(errorCode: string, errorMessage: string) {
        super(`Gateway error (code ${errorCode}): ${errorMessage}`);
        this.errorCode = errorCode;
        this.errorMessage = errorMessage;
    }
}

/**
 * Thrown when `safeRegister()` detects that the order was already registered
 * (SATIM ErrorCode 1) but the original orderId could not be recovered.
 *
 * The `merchantRef` is included so the caller can look up the original
 * orderId in their own persistence layer and call `status()` or `confirm()`.
 */
export class SatimDuplicateOrderError extends SatimError {
    public readonly merchantRef: string;

    constructor(merchantRef: string) {
        super(
            `Order for merchant reference "${merchantRef}" was already registered. ` +
            `Use status() with the original orderId to check its state.`,
        );
        this.merchantRef = merchantRef;
    }
}

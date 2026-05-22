/**
 * SATIM SDK error hierarchy.
 * @file
 */

/** Base error class; catch this to handle any SDK error uniformly. */
export class SatimError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Required configuration value or response field absent. */
export class SatimMissingDataError extends SatimError {}

/** Argument failed validation. */
export class SatimInvalidArgumentError extends SatimError {}

/** Gateway rejected credentials (ErrorCode 5). */
export class SatimInvalidCredentialsError extends SatimError {}

/** Safe error category — no raw stack traces or system codes leak through. */
export type SatimErrorCategory =
    | "network" | "timeout" | "parse" | "http"
    | "gateway" | "circuit_open" | "unknown";

/** Unexpected/malformed gateway response or transport failure. */
export class SatimUnexpectedResponseError extends SatimError {
    public readonly errorCategory: SatimErrorCategory;
    public readonly gatewayErrorCode?: string;
    public readonly gatewayErrorMessage?: string;
    public readonly isTimeout: boolean;
    public readonly httpStatus?: number;

    constructor(
        message: string,
        category: SatimErrorCategory = "unknown",
        gateway?: { errorCode?: string; errorMessage?: string },
        metadata?: { isTimeout?: boolean; httpStatus?: number },
    ) {
        super(message);
        this.errorCategory = category;
        this.gatewayErrorCode = gateway?.errorCode;
        this.gatewayErrorMessage = gateway?.errorMessage;
        this.isTimeout = metadata?.isTimeout ?? false;
        this.httpStatus = metadata?.httpStatus;
    }
}

/**
 * Typed BPC gateway error. Known codes:
 * 1 = duplicate order, 3 = unknown currency, 4 = missing param, 7 = system error.
 */
export class SatimGatewayError extends SatimError {
    constructor(
        public readonly errorCode: string,
        public readonly errorMessage: string,
    ) {
        super(`Gateway error (code ${errorCode}): ${errorMessage}`);
    }
}

/**
 * Thrown when safeRegister detects an existing order (ErrorCode 1).
 * The caller should look up the original orderId via their persistence layer
 * and call status() or confirm() with it.
 */
export class SatimDuplicateOrderError extends SatimError {
    constructor(public readonly merchantRef: string) {
        super(
            `Order for merchant reference "${merchantRef}" was already registered. ` +
            `Use status() with the original orderId to check its state.`,
        );
    }
}

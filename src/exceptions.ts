/**
 * SATIM SDK error hierarchy. All exceptions descend from `SatimError` —
 * catch it for any SDK failure, or narrow to a subclass for typed recovery.
 * @file
 */

/**
 * Base error class. Sets `name` to the concrete subclass name and restores
 * the prototype chain for reliable `instanceof` checks across module
 * boundaries and transpilation targets.
 */
export class SatimError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Required configuration value or response field is missing — e.g. an unset
 * `returnUrl`/`amount` on register, a `formUrl`-less register response, or a
 * `WebhookHandler` built without `onResolveAmount`.
 */
export class SatimMissingDataError extends SatimError {}

/**
 * Method argument failed validation. Thrown by `SatimConfig` setters, the
 * `assert*` amount/order-id helpers, `redirectResponse()` on an untrusted
 * `formUrl`, and by gateway `ErrorCode: "6"` (unknown order).
 */
export class SatimInvalidArgumentError extends SatimError {}

/**
 * Gateway rejected the merchant credentials (`ErrorCode: "5"`).
 * Indicates a configuration problem: wrong `username`, `password`, or
 * `terminalId`. Not retryable.
 */
export class SatimInvalidCredentialsError extends SatimError {}

/**
 * Safe failure-category classification for `SatimUnexpectedResponseError`.
 * Carries no raw messages, stack traces, or system codes, so it's safe to
 * include `errorCategory` in alerts without leaking internals.
 */
export type SatimErrorCategory =
    | "network" | "timeout" | "parse" | "http"
    | "gateway" | "circuit_open" | "unknown";

/**
 * Transport or protocol failure with the SATIM gateway. `errorCategory`
 * narrows the cause: `"network"` (fetch rejection), `"timeout"` (carries
 * `isTimeout: true`), `"parse"` (bad JSON), `"http"` (carries `httpStatus`),
 * `"gateway"` (unrecognised non-zero `ErrorCode`), `"circuit_open"`, or
 * `"unknown"`. Also thrown by `verifyAmount()` on amount mismatch and by
 * response constructors on schema validation failure.
 */
export class SatimUnexpectedResponseError extends SatimError {
    public readonly errorCategory: SatimErrorCategory;
    public readonly gatewayErrorCode?: string;
    public readonly gatewayErrorMessage?: string;
    public readonly isTimeout: boolean;
    public readonly httpStatus?: number;

    /**
     * @param message Free-form description (never includes raw gateway internals — sanitised by caller).
     * @param category One of {@link SatimErrorCategory}.
     * @param gateway Optional typed BPC fields.
     * @param metadata Transport hints (`isTimeout`, `httpStatus`) used by the retry decision.
     */
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

/** Typed BPC gateway error for the well-known codes.
 * | Code | Meaning |
 * |------|---------|
 * | `"1"` | Duplicate order (used by `safeRegister` for idempotency). |
 * | `"3"` | Unknown currency. |
 * | `"4"` | Missing required parameter. |
 * | `"7"` | Gateway internal error. |
 * `errorMessage` is sanitised (truncated, non-printable bytes stripped).
 */
export class SatimGatewayError extends SatimError {
    /**
     * @param errorCode Numeric string in {"1","3","4","7"} per BPC spec.
     * @param errorMessage Sanitised human-readable description.
     */
    constructor(
        public readonly errorCode: string,
        public readonly errorMessage: string,
    ) {
        super(`Gateway error (code ${errorCode}): ${errorMessage}`);
    }
}

/**
 * Thrown by `safeRegister`/`safeRegisterPreAuth` when the gateway already
 * has an order for this `merchantRef` (`ErrorCode: "1"`). Look up the
 * original `orderId` and call `status()` — do not retry registration.
 */
export class SatimDuplicateOrderError extends SatimError {
    /**
     * @param merchantRef Caller-supplied stable order reference that
     *                    triggered the duplicate-order rejection.
     */
    constructor(public readonly merchantRef: string) {
        super(
            `Order for merchant reference "${merchantRef}" was already registered. ` +
            `Use status() with the original orderId to check its state.`,
        );
    }
}

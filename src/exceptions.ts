/**
 * SATIM SDK error hierarchy.
 *
 * All exceptions thrown by the SDK descend from `SatimError`. Callers can
 * catch the base class to handle any SDK failure uniformly, or narrow to
 * a specific subclass for typed recovery.
 *
 * Failure-state taxonomy:
 * - Input rejected by the SDK before any network call: `SatimMissingDataError`, `SatimInvalidArgumentError`.
 * - Gateway rejected the request semantically: `SatimInvalidCredentialsError`, `SatimGatewayError`, `SatimInvalidArgumentError`.
 * - Transport or protocol failure: `SatimUnexpectedResponseError`.
 * - Idempotency conflict surfaced by `safeRegister`/`safeRegisterPreAuth`: `SatimDuplicateOrderError`.
 * @file
 */

/**
 * Base error for all SDK exceptions. Sets `name` to the concrete subclass
 * name and restores the prototype chain for reliable `instanceof` checks
 * across module boundaries and transpilation targets.
 */
export class SatimError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Required configuration value or response field is absent.
 *
 * Thrown for:
 * - `Satim.register()` / `Satim.registerPreAuth()` / `safeRegister()` /
 *   `safeRegisterPreAuth()` when `returnUrl` or `amount` was not set.
 * - `RegisterResponse.getUrl()` when the gateway response carried no `formUrl`.
 * - `WebhookHandler` construction without `onResolveAmount`.
 */
export class SatimMissingDataError extends SatimError {}

/**
 * Method argument failed validation.
 *
 * Thrown by every fluent setter on `SatimConfig`, by `assertOrderId`,
 * `assertRegisterAmount`, `assertConfirmAmount`, `assertRefundAmount`,
 * and by `RegisterResponse.redirectResponse()` when the gateway-supplied
 * `formUrl` is non-HTTPS or not on a trusted `*.satim.dz` host.
 *
 * Also raised by the HTTP layer in response to gateway `ErrorCode: "6"`
 * (unknown order).
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
 *
 * No raw error messages, stack traces, or system codes are exposed via
 * this enum — error reporters that include `errorCategory` in alerts
 * cannot leak request URLs, form-body contents, or internal infrastructure
 * details.
 */
export type SatimErrorCategory =
    | "network" | "timeout" | "parse" | "http"
    | "gateway" | "circuit_open" | "unknown";

/**
 * Transport or protocol failure communicating with the SATIM gateway.
 *
 * Categories:
 * - `"network"` — `fetch` rejection unrelated to timeout (DNS, connection refused).
 * - `"timeout"` — `AbortController` fired the per-request timeout. Carries `isTimeout: true`.
 * - `"parse"` — gateway response body was not valid JSON.
 * - `"http"` — non-2xx HTTP status. Carries `httpStatus`.
 * - `"gateway"` — gateway returned a non-zero `ErrorCode` not in {1,3,4,5,6,7}, or a malformed response shape.
 * - `"circuit_open"` — circuit breaker rejected the request without dispatching.
 * - `"unknown"` — fallback for unclassified failures.
 *
 * Also thrown by `ConfirmResponse.verifyAmount()` when the captured amount
 * does not match the expected amount, and by response constructors when
 * the gateway payload fails runtime schema validation.
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

/**
 * Typed BPC gateway error for the well-known codes.
 *
 * | `errorCode` | Meaning |
 * |-------------|---------|
 * | `"1"` | Duplicate order number — used by `safeRegister` to detect idempotency conflicts. |
 * | `"3"` | Unknown currency. |
 * | `"4"` | Missing required parameter. |
 * | `"7"` | Gateway internal error. |
 *
 * `errorMessage` is the sanitised gateway message (truncated to 200 chars,
 * non-printable bytes stripped).
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
 * `safeRegister`/`safeRegisterPreAuth` detected that the gateway already
 * has an order for the supplied `merchantRef` (translated from `ErrorCode: "1"`).
 *
 * Recovery: look up the original `orderId` in the merchant's persistence
 * layer (keyed by `merchantRef`) and call `status(orderId)` to inspect
 * its state. Do not retry registration — the existing order is canonical.
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

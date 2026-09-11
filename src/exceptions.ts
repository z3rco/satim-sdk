export class SatimError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class SatimMissingDataError extends SatimError {}

export class SatimInvalidArgumentError extends SatimError {}

export class SatimInvalidCredentialsError extends SatimError {}

export type SatimErrorCategory =
    | "network" | "timeout" | "parse" | "http"
    | "gateway" | "circuit_open" | "unknown";

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

export class SatimGatewayError extends SatimError {

    constructor(
        public readonly errorCode: string,
        public readonly errorMessage: string,
    ) {
        super(`Gateway error (code ${errorCode}): ${errorMessage}`);
    }
}

export class SatimDuplicateOrderError extends SatimError {

    constructor(public readonly merchantRef: string) {
        super(
            `Order for merchant reference "${merchantRef}" was already registered. ` +
            `Use status() with the original orderId to check its state.`,
        );
    }
}

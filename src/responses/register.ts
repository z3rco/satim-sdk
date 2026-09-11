import { SatimMissingDataError, SatimInvalidArgumentError } from "../exceptions.js";
import type { RegisterOrderResponse } from "../types.js";
import { validateRegisterSchema } from "./schema.js";

const TRUSTED_SATIM_HOSTNAMES = new Set([
    "satim.dz", "cib.satim.dz", "test.satim.dz", "test2.satim.dz",
]);

export class RegisterResponse {
    private readonly _raw: RegisterOrderResponse;

    constructor(raw: RegisterOrderResponse) {
        validateRegisterSchema(raw);
        this._raw = structuredClone(raw);
    }

    public getOrderId(): string {
        return this._raw.orderId;
    }

    public getUrl(): string {
        if (!this._raw.formUrl) throw new SatimMissingDataError("No payment form URL found.");
        return this._raw.formUrl;
    }

    public redirectResponse(): Response {
        const url = this.getUrl();
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:") {
                throw new SatimInvalidArgumentError("Payment form URL must use HTTPS.");
            }
            if (!TRUSTED_SATIM_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
                throw new SatimInvalidArgumentError(
                    `Untrusted payment form URL origin: ${parsed.hostname.toLowerCase()}. Expected a known satim.dz hostname.`,
                );
            }
        } catch (err) {
            if (err instanceof SatimInvalidArgumentError) throw err;
            throw new SatimInvalidArgumentError("Invalid payment form URL received from gateway.");
        }
        return Response.redirect(url, 302);
    }

    public getRawResponse(): RegisterOrderResponse {
        return { ...this._raw };
    }
}

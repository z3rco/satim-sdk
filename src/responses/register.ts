/**
 * RegisterResponse: wraps /register.do and /registerPreAuth.do gateway results.
 * @file
 */

import { SatimMissingDataError, SatimInvalidArgumentError } from "../exceptions";
import type { RegisterOrderResponse } from "../types";
import { validateRegisterSchema } from "./schema";

const TRUSTED_SATIM_HOSTNAMES = new Set([
    "satim.dz", "cib.satim.dz", "test.satim.dz", "test2.satim.dz",
]);

/** Immutable wrapper around a registration response with redirect helper. */
export class RegisterResponse {
    private readonly _raw: RegisterOrderResponse;

    constructor(raw: RegisterOrderResponse) {
        validateRegisterSchema(raw);
        this._raw = structuredClone(raw);
    }

    /** @returns Gateway-assigned order identifier. */
    public getOrderId(): string {
        return this._raw.orderId;
    }

    /**
     * @returns Hosted payment form URL.
     * @throws SatimMissingDataError when no URL is present.
     */
    public getUrl(): string {
        if (!this._raw.formUrl) throw new SatimMissingDataError("No payment form URL found.");
        return this._raw.formUrl;
    }

    /**
     * Build a Web API 302 redirect to the hosted payment form.
     * @throws SatimInvalidArgumentError when URL is non-HTTPS or not a trusted satim.dz host.
     */
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

    /** Sanitized copy of the raw gateway response for debugging. */
    public getRawResponse(): RegisterOrderResponse {
        return { ...this._raw };
    }
}

import { SatimMissingDataError, SatimInvalidArgumentError } from "../exceptions.js";
import type { RegisterOrderResponse } from "../types.js";
import { validateRegisterSchema } from "./schema.js";

const TRUSTED_SATIM_HOSTNAMES = new Set([
    "satim.dz", "cib.satim.dz", "test.satim.dz", "test2.satim.dz",
]);

// The only barrier against a tampered gateway redirecting customers to an attacker domain; enforced on every path that hands out the URL, not just redirectResponse().
function assertTrustedFormUrl(url: string): void {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new SatimInvalidArgumentError("Invalid payment form URL received from gateway.");
    }
    if (parsed.protocol !== "https:") {
        throw new SatimInvalidArgumentError("Payment form URL must use HTTPS.");
    }
    if (!TRUSTED_SATIM_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
        throw new SatimInvalidArgumentError(
            `Untrusted payment form URL origin: ${parsed.hostname.toLowerCase()}. Expected a known satim.dz hostname.`,
        );
    }
}

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
        assertTrustedFormUrl(this._raw.formUrl);
        return this._raw.formUrl;
    }

    public redirectResponse(): Response {
        return Response.redirect(this.getUrl(), 302);
    }

    public getRawResponse(): RegisterOrderResponse {
        return { ...this._raw };
    }
}

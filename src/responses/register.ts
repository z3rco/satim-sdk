/**
 * `RegisterResponse`: typed wrapper for `/register.do` and
 * `/registerPreAuth.do` gateway results.
 *
 * `redirectResponse()` enforces an HTTPS + `*.satim.dz` allowlist on the
 * gateway's `formUrl` — the only barrier against a tampered gateway
 * redirecting customers to an attacker-controlled domain.
 * @file
 */

import { SatimMissingDataError, SatimInvalidArgumentError } from "../exceptions.js";
import type { RegisterOrderResponse } from "../types.js";
import { validateRegisterSchema } from "./schema.js";

/** Hostnames permitted as redirect targets. Never loosen this list. */
const TRUSTED_SATIM_HOSTNAMES = new Set([
    "satim.dz", "cib.satim.dz", "test.satim.dz", "test2.satim.dz",
]);

/**
 * Immutable wrapper around a registration response. `_raw` is a deep
 * clone made at construction; no mutators are exposed.
 */
export class RegisterResponse {
    private readonly _raw: RegisterOrderResponse;

    /**
     * Validates and deep-clones the gateway payload.
     * @throws {@link SatimUnexpectedResponseError} on schema violations.
     */
    constructor(raw: RegisterOrderResponse) {
        validateRegisterSchema(raw);
        this._raw = structuredClone(raw);
    }

    /** @returns The gateway-assigned order identifier. Always present after construction. */
    public getOrderId(): string {
        return this._raw.orderId;
    }

    /**
     * @returns The hosted payment form URL.
     * @throws {@link SatimMissingDataError} when no URL is present (in
     *         practice unreachable — schema validation requires it).
     */
    public getUrl(): string {
        if (!this._raw.formUrl) throw new SatimMissingDataError("No payment form URL found.");
        return this._raw.formUrl;
    }

    /**
     * Build a Web API 302 redirect to the hosted payment form. Enforces
     * HTTPS and the {@link TRUSTED_SATIM_HOSTNAMES} allowlist — the only
     * barrier against a gateway redirecting to an attacker-controlled domain.
     * @throws {@link SatimInvalidArgumentError} when `formUrl` is not
     *         HTTPS, not on a trusted host, or fails URL parsing.
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

    /** @returns A shallow copy of the raw gateway response, for debugging; prefer typed accessors otherwise. */
    public getRawResponse(): RegisterOrderResponse {
        return { ...this._raw };
    }
}

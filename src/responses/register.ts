/**
 * `RegisterResponse`: typed wrapper for `/register.do` and
 * `/registerPreAuth.do` gateway results.
 *
 * Constructor runs runtime schema validation, then `structuredClone`s the
 * raw payload so the wrapper is decoupled from any external reference the
 * HTTP client might still hold.
 *
 * `redirectResponse()` enforces an HTTPS allowlist (`*.satim.dz`) on the
 * `formUrl` returned by the gateway — defence against a compromised or
 * tampered gateway redirecting customers to attacker-controlled domains.
 * @file
 */

import { SatimMissingDataError, SatimInvalidArgumentError } from "../exceptions";
import type { RegisterOrderResponse } from "../types";
import { validateRegisterSchema } from "./schema";

/**
 * Hostnames permitted as redirect targets.
 *
 * Tightening: removing entries here breaks any tooling that points the
 * SDK at custom SATIM-compatible gateways. Loosening: never.
 */
const TRUSTED_SATIM_HOSTNAMES = new Set([
    "satim.dz", "cib.satim.dz", "test.satim.dz", "test2.satim.dz",
]);

/**
 * Immutable wrapper around a registration response.
 *
 * Invariants:
 * - `_raw` is a deep clone of the gateway payload, made at construction time.
 * - The wrapper exposes no mutator methods; callers cannot affect SDK state.
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
     * @throws {@link SatimMissingDataError} when no URL is present.
     *         (In practice unreachable because `validateRegisterSchema`
     *         enforces a non-empty `formUrl` at construction.)
     */
    public getUrl(): string {
        if (!this._raw.formUrl) throw new SatimMissingDataError("No payment form URL found.");
        return this._raw.formUrl;
    }

    /**
     * Build a Web API 302 redirect to the hosted payment form. Returns a
     * standard `Response` usable in any Web-API runtime (Cloudflare Workers,
     * Deno, Bun, Node 18+).
     *
     * Enforces HTTPS and the {@link TRUSTED_SATIM_HOSTNAMES} allowlist —
     * the only barrier against a gateway returning a `formUrl` on an
     * attacker-controlled domain.
     *
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

    /**
     * @returns A shallow copy of the raw gateway response. Suitable for
     *          debugging; prefer typed accessors for business logic.
     *          Mutating the returned object does not affect this wrapper.
     */
    public getRawResponse(): RegisterOrderResponse {
        return { ...this._raw };
    }
}

/**
 * Immutable fluent configuration base class with module-private credential isolation.
 *
 * Credentials live in a module-scoped `WeakMap<SatimConfig, Creds>`
 * declared inside this file. The mapping is unreachable from outside the
 * module — there is no exported accessor. Consequences:
 *
 * - `Object.keys(satim)`, `Reflect.ownKeys(satim)`, `JSON.stringify(satim)`,
 *   and prototype-chain traversal never expose credentials.
 * - `toJSON()`, `Symbol.for("nodejs.util.inspect.custom")`, and
 *   `Symbol.toPrimitive` all return `[REDACTED]` for the credential fields.
 * - `clone()` copies the entry from one `WeakMap` slot to another; the
 *   clone is a peer in the same map, never a holder of duplicated
 *   instance fields.
 *
 * Every fluent setter calls `clone()` and returns the clone. Cross-request
 * state leaks are impossible by construction: callers who share a base
 * `Satim` instance always observe their own configured copy.
 * @file
 */

import type { Language, CurrencyCode, SatimCredentials } from "./types";
import { SatimInvalidArgumentError, SatimMissingDataError } from "./exceptions";
import { assertSafeUrl } from "./ssrf";
import {
    assertRegisterAmount, assertDescription, assertLanguage,
    assertOrderNumber, assertTimeout, assertIdempotencyKey,
    assertUserField, assertCredentialString,
} from "./validation";

interface Creds { username: string; password: string; terminalId: string; }

/**
 * Module-private credential store.
 *
 * The `WeakMap` keys instances of `SatimConfig` directly so that when an
 * instance is garbage-collected its credentials become unreachable
 * automatically — no manual disposal required.
 */
const _credentials = new WeakMap<SatimConfig, Creds>();

const CURRENCIES: Record<string, CurrencyCode> = { DZD: "012", USD: "840", EUR: "978" };

/**
 * Configuration carrier subclassed by `Satim`.
 *
 * State invariants:
 * - `_amount`, `_returnUrl`, `_failUrl`, `_description`, `_orderNumber`,
 *   `_sessionTimeoutSecs`, `_dynamicCallbackUrl`, `_idempotencyKey` are
 *   `undefined` until set, then validated values.
 * - `_language` and `_currency` always carry default values (`"FR"`, `"012"`).
 * - `_userDefinedFields` always references a fresh object after `clone()`
 *   so concurrent mutation through a child setter does not leak into the parent.
 * - Credentials are present in `_credentials.get(this)` exactly once after
 *   `initFromCredentials` runs; re-initialization is rejected.
 */
export class SatimConfig {
    protected testMode = false;
    protected _language: Language = "FR";
    protected _currency: CurrencyCode = "012";
    protected _amount?: number;
    protected _failUrl?: string;
    protected _returnUrl?: string;
    protected _dynamicCallbackUrl?: string;
    protected _description?: string;
    protected _orderNumber?: string;
    protected _sessionTimeoutSecs?: number;
    protected _idempotencyKey?: string;
    protected _userDefinedFields: Record<string, string> = {};

    /** @returns Merchant username. Protected — never exposed publicly. */
    protected get username(): string { return _credentials.get(this)!.username; }
    /** @returns Merchant password. Protected — never exposed publicly. */
    protected get password(): string { return _credentials.get(this)!.password; }
    /** @returns Merchant terminal ID. Protected — never exposed publicly. */
    protected get terminalId(): string { return _credentials.get(this)!.terminalId; }

    /**
     * Bind credentials to this instance via the module-private `WeakMap`.
     *
     * Preconditions: this instance has no credentials currently bound;
     * all three fields are non-empty strings after trim, with `username`
     * and `password` ≤ 100 chars and `terminalId` ≤ 16 chars.
     *
     * Runtime type guards reject objects that satisfy `SatimCredentials`
     * structurally but carry non-string payloads. Cannot be called twice
     * on the same instance.
     *
     * @throws {@link SatimInvalidArgumentError} when credentials are
     *         already bound, any field is non-string, or length limits
     *         (AN.100 / AN.16) are exceeded.
     * @throws {@link SatimMissingDataError} when any field is empty after trim.
     */
    protected initFromCredentials(c: SatimCredentials): void {
        if (_credentials.has(this)) {
            throw new SatimInvalidArgumentError("Credentials have already been initialized and cannot be re-set.");
        }
        assertCredentialString(c.username, "username");
        assertCredentialString(c.password, "password");
        assertCredentialString(c.terminalId, "terminalId");
        const username = c.username.trim();
        const password = c.password.trim();
        const terminalId = c.terminalId.trim();
        if (!username || !password || !terminalId) {
            throw new SatimMissingDataError("Missing required data: username, password, or terminalId");
        }
        if (username.length > 100 || password.length > 100) {
            throw new SatimInvalidArgumentError("Username and password must not exceed 100 characters (SATIM AN.100 limit).");
        }
        if (terminalId.length > 16) {
            throw new SatimInvalidArgumentError("Terminal ID must not exceed 16 characters (SATIM AN.16 limit).");
        }
        _credentials.set(this, { username, password, terminalId });
    }

    /**
     * Produce a fresh `SatimConfig` (or subclass) with the same state.
     *
     * Uses `Object.create(Object.getPrototypeOf(this))` so the clone is
     * the same concrete class. Fields are copied explicitly — not via
     * `Object.assign` — so subclasses can override `clone()` to copy their
     * own additional fields without risk of `Object.assign` accidentally
     * copying internal state from the wrong source.
     *
     * `_userDefinedFields` is spread (shallow copy) so child setters do
     * not mutate the parent's object.
     *
     * Credentials are copied from `_credentials.get(this)` to
     * `_credentials.set(clone, …)` — the credential map gets a peer
     * entry, not a shared reference to the same triple.
     *
     * Complexity: O(k) where k is the number of user-defined fields.
     * Effectively O(1) for typical use.
     *
     * @returns Independent clone safe to mutate without affecting `this`.
     */
    protected clone(): this {
        const c = Object.create(Object.getPrototypeOf(this)) as this;
        c.testMode = this.testMode;
        c._language = this._language;
        c._currency = this._currency;
        c._amount = this._amount;
        c._failUrl = this._failUrl;
        c._returnUrl = this._returnUrl;
        c._dynamicCallbackUrl = this._dynamicCallbackUrl;
        c._description = this._description;
        c._orderNumber = this._orderNumber;
        c._sessionTimeoutSecs = this._sessionTimeoutSecs;
        c._idempotencyKey = this._idempotencyKey;
        c._userDefinedFields = { ...this._userDefinedFields };
        const creds = _credentials.get(this);
        if (creds) _credentials.set(c, { ...creds });
        return c;
    }

    // ─── Fluent setters ──────────────────────────────────────────────────
    // Each setter validates input, clones, mutates the clone, returns it.
    // The original instance is never modified.

    /**
     * Set the payment amount in major currency units (whole DA for register).
     *
     * @returns Clone with the amount set.
     * @throws {@link SatimInvalidArgumentError} via {@link assertRegisterAmount}
     *         on shape violations, sub-50-DA values, or fractional dinars.
     */
    public amount(amount: number): this {
        assertRegisterAmount(amount);
        const c = this.clone(); c._amount = amount; return c;
    }

    /**
     * Set the payment-page description (SATIM AN.600).
     * @throws {@link SatimInvalidArgumentError} on non-string, overlong, or markup-bearing input.
     */
    public description(description: string): this {
        assertDescription(description);
        const c = this.clone(); c._description = description; return c;
    }

    /**
     * Set the payment currency by ISO 3-letter code.
     * @param curr One of `"DZD"`, `"USD"`, `"EUR"`. Mapped to numeric ISO 4217 internally.
     * @throws {@link SatimInvalidArgumentError} on unsupported currencies.
     */
    public currency(curr: "DZD" | "USD" | "EUR"): this {
        const code = CURRENCIES[curr];
        if (!code) throw new SatimInvalidArgumentError("Invalid currency: Allowed currencies are [DZD, USD, EUR].");
        const c = this.clone(); c._currency = code; return c;
    }

    /**
     * Set the URL the customer is redirected to on payment failure.
     * Falls back to `returnUrl` when sent to the gateway if not set.
     * @throws {@link SatimInvalidArgumentError} via {@link assertSafeUrl}.
     */
    public failUrl(url: string): this {
        assertSafeUrl(url, "Invalid fail URL. Must be a valid http/https URL.");
        const c = this.clone(); c._failUrl = url; return c;
    }

    /**
     * Set the URL the customer is redirected to after payment.
     * @throws {@link SatimInvalidArgumentError} via {@link assertSafeUrl}.
     */
    public returnUrl(url: string): this {
        assertSafeUrl(url, "Invalid return URL. Must be a valid http/https URL.");
        const c = this.clone(); c._returnUrl = url; return c;
    }

    /**
     * Set the server-to-server webhook URL the gateway POSTs status changes to.
     * @throws {@link SatimInvalidArgumentError} via {@link assertSafeUrl}.
     */
    public dynamicCallbackUrl(url: string): this {
        assertSafeUrl(url, "Invalid dynamic callback URL. Must be a valid http/https URL.");
        const c = this.clone(); c._dynamicCallbackUrl = url; return c;
    }

    /**
     * Set a custom 1-10 character alphasatim-module order number.
     * Defaults to a CSPRNG-generated 10-digit value if unset at register time.
     * @throws {@link SatimInvalidArgumentError} on format violations.
     */
    public orderNumber(orderNumber: string | number): this {
        const str = assertOrderNumber(orderNumber);
        const c = this.clone(); c._orderNumber = str; return c;
    }

    /**
     * Toggle between production (`cib.satim.dz`) and test (`test2.satim.dz`) gateway.
     * The `Satim` subclass overrides this to rebuild its default HTTP client
     * with the matching base URL.
     */
    public setTestMode(isEnabled: boolean): this {
        const c = this.clone(); c.testMode = isEnabled; return c;
    }

    /**
     * Set the hosted payment form language.
     * @throws {@link SatimInvalidArgumentError} on unsupported codes.
     */
    public language(lang: Language): this {
        assertLanguage(lang);
        const c = this.clone(); c._language = lang.toUpperCase() as Language; return c;
    }

    /**
     * Set a single `jsonParams` key/value pair.
     *
     * Reserved keys (`force_terminal_id`, `__proto__`, `constructor`,
     * `prototype`) are rejected here as the first line of defence against
     * terminal-ID injection and prototype pollution. The `Satim.buildData`
     * method strips `force_terminal_id` again before send, providing
     * defence in depth.
     *
     * @throws {@link SatimInvalidArgumentError} on reserved keys, malformed
     *         keys, non-string values, or values exceeding 20 characters.
     */
    public userDefinedField(key: string, value: string): this {
        assertUserField(key, value);
        const c = this.clone(); c._userDefinedFields[key] = value; return c;
    }

    /**
     * Set multiple `jsonParams` key/value pairs.
     *
     * Iterates own enumerable properties only; inherited and symbol-keyed
     * properties are ignored. Each pair is validated as if passed to
     * {@link userDefinedField}.
     *
     * Complexity: O(n) where n is the number of fields.
     *
     * @throws {@link SatimInvalidArgumentError} on the first invalid entry.
     */
    public userDefinedFields(fields: Record<string, string>): this {
        let cur: this = this;
        for (const [k, v] of Object.entries(fields)) cur = cur.userDefinedField(k, v);
        return cur;
    }

    /**
     * Set the payment session timeout in seconds (`[600, 86400]`).
     * @throws {@link SatimInvalidArgumentError} on out-of-range or non-integer input.
     */
    public timeout(seconds: number): this {
        assertTimeout(seconds);
        const c = this.clone(); c._sessionTimeoutSecs = seconds; return c;
    }

    /**
     * Set the idempotency key (`externalRequestId`).
     *
     * Setting an idempotency key enables automatic retries for `register()`
     * and `registerPreAuth()` — see `Satim.registerAt`. Without a key,
     * registration is not retried because a retry after a timeout could
     * create a duplicate order on the gateway.
     *
     * Use {@link deriveIdempotencyKey} to derive a stable key from your
     * internal order reference, or call `safeRegister(merchantRef)` for
     * a one-shot wrapper that does the derivation.
     *
     * @throws {@link SatimInvalidArgumentError} on format violations.
     */
    public idempotencyKey(key: string): this {
        assertIdempotencyKey(key);
        const c = this.clone(); c._idempotencyKey = key; return c;
    }

    // ─── Redacting serializers ───────────────────────────────────────────

    /**
     * Custom JSON serializer that redacts credentials.
     *
     * Called automatically by `JSON.stringify(satim)`. Returns a snapshot
     * with `username`, `password`, `terminalId` replaced by `"[REDACTED]"`
     * and all other configuration state intact (for debugging).
     */
    public toJSON(): Record<string, unknown> {
        return {
            username: "[REDACTED]",
            password: "[REDACTED]",
            terminalId: "[REDACTED]",
            testMode: this.testMode,
            language: this._language,
            amount: this._amount,
            currency: this._currency,
            returnUrl: this._returnUrl,
            failUrl: this._failUrl,
            description: this._description,
            orderNumber: this._orderNumber,
            sessionTimeoutSecs: this._sessionTimeoutSecs,
            idempotencyKey: this._idempotencyKey,
        };
    }

    /** Node.js `util.inspect` hook — returns the same redacted snapshot as `toJSON`. */
    public [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
        return this.toJSON();
    }

    /** Stringification — never reveals credentials. */
    public toString(): string {
        return "[SatimConfig credentials=REDACTED]";
    }

    /** Primitive coercion hook — delegates to `toString`. */
    public [Symbol.toPrimitive](): string {
        return this.toString();
    }
}

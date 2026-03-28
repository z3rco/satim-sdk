import type { Language, CurrencyCode, SatimCredentials } from "./types";
import { SatimInvalidArgumentError, SatimMissingDataError } from "./exceptions";
import { MAX_SAFE_AMOUNT, toMinorUnits, hasSubCentimePrecision } from "./utils";

/** Private IP ranges and cloud metadata IPs that should be blocked in URLs. */
const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "[::1]",
    "metadata.google.internal",
]);

/** Patterns matching private/reserved IPv4 ranges. */
const PRIVATE_IP_PATTERNS = [
    /^127\./, // Loopback
    /^10\./, // Class A private
    /^172\.(1[6-9]|2\d|3[01])\./, // Class B private
    /^192\.168\./, // Class C private
    /^169\.254\./, // Link-local / cloud metadata
    /^0\./, // "This" network
];

/** Patterns matching private/reserved IPv6 ranges (case-insensitive). */
const PRIVATE_IPV6_PATTERNS = [
    /^::1$/i, // Loopback
    /^::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/i, // IPv4-mapped (dotted)
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i, // IPv4-mapped 127.x.x.x in hex (URL-normalized)
    /^::ffff:(a[0-9a-f]{0,2}|ac1[0-9a-f]|c0a8|a9fe):[0-9a-f]{1,4}$/i, // IPv4-mapped 10.x, 172.16-31.x, 192.168.x, 169.254.x in hex
    /^::ffff:0:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i, // IPv4-translated 127.x.x.x (RFC 6145)
    /^::ffff:0:(a[0-9a-f]{0,2}):[0-9a-f]{1,4}$/i, // IPv4-translated 10.x.x.x
    /^::ffff:0:ac1[0-9a-f]:[0-9a-f]{1,4}$/i, // IPv4-translated 172.16-31.x
    /^::ffff:0:c0a8:[0-9a-f]{1,4}$/i, // IPv4-translated 192.168.x.x
    /^::ffff:0:a9fe:[0-9a-f]{1,4}$/i, // IPv4-translated 169.254.x.x (cloud metadata)
    /^::ffff:0:[0]{1,4}:[0-9a-f]{1,4}$/i, // IPv4-translated 0.x.x.x
    /^64:ff9b::/i, // NAT64 well-known prefix (RFC 6052)
    /^::7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i, // IPv4-compatible 127.x.x.x (::7f00:1 = 127.0.0.1)
    /^::(a[0-9a-f]{0,2}):[0-9a-f]{1,4}$/i, // IPv4-compatible 10.x.x.x (::a00:1 = 10.0.0.1)
    /^::ac1[0-9a-f]:[0-9a-f]{1,4}$/i, // IPv4-compatible 172.16-31.x (::ac10:1 = 172.16.0.1)
    /^::c0a8:[0-9a-f]{1,4}$/i, // IPv4-compatible 192.168.x.x (::c0a8:1 = 192.168.0.1)
    /^::a9fe:[0-9a-f]{1,4}$/i, // IPv4-compatible 169.254.x.x (::a9fe:a9fe = 169.254.169.254)
    /^::[0]{1,4}:[0-9a-f]{1,4}$/i, // IPv4-compatible 0.x.x.x
    /^f[cd]/i, // Unique local (fc00::/7)
    /^fe[89ab]/i, // Link-local (fe80::/10)
    /^::$/i, // Unspecified address
];

/**
 * Detect non-standard IP address encodings (decimal, octal, hex) that can
 * bypass naive string-based SSRF filters.
 *
 * Examples: `2130706433` (= 127.0.0.1), `0177.0.0.1` (octal), `0x7f.0.0.1` (hex)
 */
function isNonStandardIp(hostname: string): boolean {
    // Pure decimal integer (e.g. 2130706433)
    if (/^\d{4,}$/.test(hostname)) return true;
    // Octal notation (e.g. 0177.0.0.1)
    if (/^0\d+(\.0?\d+)*$/.test(hostname)) return true;
    // Hex notation (e.g. 0x7f.0.0.1)
    if (/0x[0-9a-f]/i.test(hostname)) return true;
    return false;
}

/**
 * Strip IPv6 brackets and expand :: shorthand into the raw address
 * for pattern matching against PRIVATE_IPV6_PATTERNS.
 */
function normalizeIpv6(hostname: string): string | null {
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
        return hostname.slice(1, -1).toLowerCase();
    }
    // Bare IPv6 (without brackets) can appear in parsed URL hostname
    if (hostname.includes(":")) {
        return hostname.toLowerCase();
    }
    return null;
}

/**
 * Module-private WeakMap storing merchant credentials.
 *
 * This prevents credential leakage via `Object.getOwnPropertyDescriptor()`,
 * `Reflect.ownKeys()`, prototype chain traversal, or any enumeration method.
 * Credentials are only accessible through the protected getters defined on
 * `SatimConfig`.
 */
const _credentials = new WeakMap<SatimConfig, { username: string; password: string; terminalId: string }>();

/**
 * Reserved keys that are not allowed in user-defined fields.
 * These keys have special meaning in the SATIM `jsonParams` payload
 * and must not be overridden by user input.
 */
const RESERVED_JSON_PARAM_KEYS = new Set([
    "force_terminal_id",
    "__proto__",
    "constructor",
    "prototype",
]);

/**
 * Abstract base class holding all payment configuration state
 * and fluent setter methods.
 *
 * Provides an immutable fluent interface to prevent cross-request state leaks.
 */
export class SatimConfig {
    protected testMode: boolean = false;

    protected _language: Language = "FR";
    protected _amount?: number;
    protected _failUrl?: string;
    protected _returnUrl?: string;
    protected _dynamicCallbackUrl?: string;
    protected _description?: string;
    protected _orderNumber?: string;
    protected _userDefinedFields: Record<string, string> = {};
    protected _sessionTimeoutSecs?: number;
    protected _currency: CurrencyCode = "012";
    protected _idempotencyKey?: string;

    protected readonly currencies: Record<string, CurrencyCode> = {
        DZD: "012",
        USD: "840",
        EUR: "978",
    };

    /** Protected getter — credentials are stored in a module-private WeakMap. */
    protected get username(): string {
        return _credentials.get(this)!.username;
    }

    /** Protected getter — credentials are stored in a module-private WeakMap. */
    protected get password(): string {
        return _credentials.get(this)!.password;
    }

    /** Protected getter — credentials are stored in a module-private WeakMap. */
    protected get terminalId(): string {
        return _credentials.get(this)!.terminalId;
    }

    /**
     * Validate and assign API credentials from the provided object.
     * Credentials are stored in a module-private WeakMap, not as instance properties.
     * @throws SatimInvalidArgumentError if credentials have already been initialized.
     * @throws SatimMissingDataError if any required field is absent.
     */
    protected initFromCredentials(creds: SatimCredentials): void {
        if (_credentials.has(this)) {
            throw new SatimInvalidArgumentError("Credentials have already been initialized and cannot be re-set.");
        }
        if (typeof creds.username !== "string" || typeof creds.password !== "string" || typeof creds.terminalId !== "string") {
            throw new SatimInvalidArgumentError("Credentials (username, password, terminalId) must all be strings.");
        }
        const username = creds.username.trim();
        const password = creds.password.trim();
        const terminalId = creds.terminalId.trim();
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

    private validateUrlScheme(urlStr: string, errorMessage: string): void {
        let parsed: URL;
        try {
            parsed = new URL(urlStr);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new Error();
            }
        } catch {
            throw new SatimInvalidArgumentError(errorMessage);
        }

        // SSRF protection: block private/internal hostnames and IPs
        const hostname = parsed.hostname.toLowerCase();
        if (BLOCKED_HOSTNAMES.has(hostname)) {
            throw new SatimInvalidArgumentError(
                `${errorMessage} URLs pointing to internal/private hosts are not allowed.`,
            );
        }
        // Block non-standard IP encodings (decimal, octal, hex) that bypass regex filters
        if (isNonStandardIp(hostname)) {
            throw new SatimInvalidArgumentError(
                `${errorMessage} Non-standard IP address encodings are not allowed.`,
            );
        }
        if (PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname))) {
            throw new SatimInvalidArgumentError(
                `${errorMessage} URLs pointing to private/reserved IP ranges are not allowed.`,
            );
        }
        // Block private/reserved IPv6 ranges (mapped, unique-local, link-local)
        const ipv6 = normalizeIpv6(hostname);
        if (ipv6 && PRIVATE_IPV6_PATTERNS.some((pattern) => pattern.test(ipv6))) {
            throw new SatimInvalidArgumentError(
                `${errorMessage} URLs pointing to private/reserved IPv6 ranges are not allowed.`,
            );
        }
    }

    /**
     * Create a clone of the current configuration.
     * Ensures the fluent API is immutable and safe for concurrent singleton usage.
     * Credentials are copied via the module-private WeakMap.
     *
     * Uses explicit property assignment instead of `Object.assign` to avoid
     * accidentally cloning sensitive properties added by subclasses.
     */
    protected clone(): this {
        const cloned = Object.create(Object.getPrototypeOf(this)) as this;
        cloned.testMode = this.testMode;
        cloned._language = this._language;
        cloned._amount = this._amount;
        cloned._failUrl = this._failUrl;
        cloned._returnUrl = this._returnUrl;
        cloned._dynamicCallbackUrl = this._dynamicCallbackUrl;
        cloned._description = this._description;
        cloned._orderNumber = this._orderNumber;
        cloned._sessionTimeoutSecs = this._sessionTimeoutSecs;
        cloned._currency = this._currency;
        cloned._idempotencyKey = this._idempotencyKey;
        cloned._userDefinedFields = { ...this._userDefinedFields };
        // Copy currencies lookup (class field — not on prototype after Object.create)
        (cloned as any).currencies = this.currencies;
        // Copy credentials to the clone via WeakMap
        const creds = _credentials.get(this);
        if (creds) {
            _credentials.set(cloned, { ...creds });
        }
        return cloned;
    }

    /**
     * Set the payment amount in major currency units (e.g. DZD or USD).
     * The SDK converts to minor units (centimes/cents) automatically when building the request.
     * Only amounts with up to 2 decimal places are accepted to prevent silent rounding.
     * @param amount - Positive number with at most 2 decimal places.
     * @throws SatimInvalidArgumentError if the amount is negative, not finite, or has sub-centime precision.
     */
    public amount(amount: number): this {
        if (typeof amount !== "number") {
            throw new SatimInvalidArgumentError(
                `Amount must be a number, got ${Array.isArray(amount) ? "array" : typeof amount}.`,
            );
        }
        if (amount <= 0 || !Number.isFinite(amount)) {
            throw new SatimInvalidArgumentError("Amount must be a finite positive number.");
        }
        if (amount > MAX_SAFE_AMOUNT) {
            throw new SatimInvalidArgumentError("Amount exceeds safe precision for minor-unit conversion.");
        }
        if (hasSubCentimePrecision(amount)) {
            throw new SatimInvalidArgumentError("Amount must not have more than 2 decimal places.");
        }
        const minor = toMinorUnits(amount);
        if (minor < 5000) {
            throw new SatimInvalidArgumentError("Amount must be at least 50 DA (5000 centimes) per SATIM requirements.");
        }
        if (minor % 100 !== 0) {
            throw new SatimInvalidArgumentError("Amount must be a multiple of 100 centimes (whole dinars only) per SATIM requirements.");
        }
        const clone = this.clone();
        clone._amount = amount;
        return clone;
    }

    /**
     * Set a human-readable description displayed on the payment page.
     * @param description - Text up to 598 characters.
     * @throws SatimInvalidArgumentError if the description exceeds the limit.
     */
    public description(description: string): this {
        if (typeof description !== "string") {
            throw new SatimInvalidArgumentError("Description must be a string.");
        }
        if (description.length > 600) {
            throw new SatimInvalidArgumentError("Description must not exceed 600 characters (SATIM AN.600 limit).");
        }
        if (/[<>]/.test(description)) {
            throw new SatimInvalidArgumentError("Description must not contain HTML markup characters (< or >).");
        }
        const clone = this.clone();
        clone._description = description;
        return clone;
    }

    /**
     * Set the payment currency.
     * @param curr - One of "DZD", "USD", or "EUR".
     * @throws SatimInvalidArgumentError if the currency is not supported.
     */
    public currency(curr: "DZD" | "USD" | "EUR"): this {
        if (!this.currencies[curr]) {
            throw new SatimInvalidArgumentError("Invalid currency: Allowed currencies are [DZD, USD, EUR].");
        }
        const clone = this.clone();
        clone._currency = this.currencies[curr];
        return clone;
    }

    /**
     * Set the URL the customer is redirected to when payment fails.
     * Falls back to the returnUrl if not specified.
     * @throws SatimInvalidArgumentError if the URL is malformed or not http/https.
     */
    public failUrl(url: string): this {
        this.validateUrlScheme(url, "Invalid fail URL. Must be a valid http/https URL.");
        const clone = this.clone();
        clone._failUrl = url;
        return clone;
    }

    /**
     * Set the URL the customer is redirected to after a successful payment.
     * @throws SatimInvalidArgumentError if the URL is malformed or not http/https.
     */
    public returnUrl(url: string): this {
        this.validateUrlScheme(url, "Invalid return URL. Must be a valid http/https URL.");
        const clone = this.clone();
        clone._returnUrl = url;
        return clone;
    }

    /**
     * Set a server-to-server callback URL that the gateway will POST to
     * when the order status changes, independently of the customer redirect.
     *
     * @throws SatimInvalidArgumentError if the URL is malformed or not http/https.
     */
    public dynamicCallbackUrl(url: string): this {
        this.validateUrlScheme(url, "Invalid dynamic callback URL. Must be a valid http/https URL.");
        const clone = this.clone();
        clone._dynamicCallbackUrl = url;
        return clone;
    }

    /**
     * Set a custom order number.
     *
     * Per the SATIM spec, `orderNumber` is AN.10 (alphanumeric, max 10 characters).
     * If not set, a random 10-character numeric string is generated automatically.
     *
     * Accepts either a string (up to 10 alphanumeric chars) or a number
     * (converted to string, must fit within 10 digits).
     *
     * @throws SatimInvalidArgumentError if the value is empty, too long, or contains invalid characters.
     */
    public orderNumber(orderNumber: string | number): this {
        const str = String(orderNumber);
        if (!str || !/^[a-zA-Z0-9]{1,10}$/.test(str)) {
            throw new SatimInvalidArgumentError(
                "Order number must be 1-10 alphanumeric characters (SATIM AN.10).",
            );
        }
        const clone = this.clone();
        clone._orderNumber = str;
        return clone;
    }

    /**
     * Toggle between the production and test (sandbox) API environments.
     * @param isEnabled - True to use the test gateway.
     */
    public setTestMode(isEnabled: boolean): this {
        const clone = this.clone();
        clone.testMode = isEnabled;
        return clone;
    }

    /**
     * Set the language of the hosted payment page.
     * @param lang - One of "FR", "AR", or "EN".
     * @throws SatimInvalidArgumentError if the language code is not supported.
     */
    public language(lang: Language): this {
        if (typeof lang !== "string") {
            throw new SatimInvalidArgumentError("Language must be a string.");
        }
        const ucLang = lang.toUpperCase();
        if (!["FR", "AR", "EN"].includes(ucLang)) {
            throw new SatimInvalidArgumentError("Language must be FR, AR, or EN.");
        }
        const clone = this.clone();
        clone._language = ucLang as Language;
        return clone;
    }

    /**
     * Add a single user-defined key/value pair to the payment metadata.
     * These are forwarded inside the `jsonParams` object.
     * @throws SatimInvalidArgumentError if the key is a numeric string, empty, or a reserved key.
     */
    public userDefinedField(key: string, value: string): this {
        if (!key || /^\d+$/.test(key)) {
            throw new SatimInvalidArgumentError("User defined field key must be a non-empty, non-numeric string.");
        }
        if (key.length > 128) {
            throw new SatimInvalidArgumentError("User defined field key must not exceed 128 characters.");
        }
        if (RESERVED_JSON_PARAM_KEYS.has(key)) {
            throw new SatimInvalidArgumentError(
                `User defined field key "${key}" is reserved and cannot be set by the caller.`,
            );
        }
        if (typeof value !== "string") {
            throw new SatimInvalidArgumentError("User defined field value must be a string.");
        }
        // udf1-udf5 are AN.20 per SATIM spec; force_terminal_id is stripped separately
        if (value.length > 20) {
            throw new SatimInvalidArgumentError("User defined field value must not exceed 20 characters (SATIM AN.20 limit).");
        }
        const clone = this.clone();
        clone._userDefinedFields[key] = value;
        return clone;
    }

    /**
     * Add multiple user-defined key/value pairs to the payment metadata.
     * Only own enumerable string properties are processed;
     * inherited/prototype properties are ignored.
     * @param fields - An object of string key/value pairs.
     */
    public userDefinedFields(fields: Record<string, string>): this {
        let current: this = this;
        for (const [key, val] of Object.entries(fields)) {
            current = current.userDefinedField(key, val);
        }
        return current;
    }

    /**
     * Set the payment session timeout.
     * @param seconds - Value between 600 (10 min) and 86400 (24 h).
     * @throws SatimInvalidArgumentError if the value is out of range.
     */
    public timeout(seconds: number): this {
        if (!Number.isInteger(seconds) || seconds < 600 || seconds > 86400) {
            throw new SatimInvalidArgumentError("Session timeout must be an integer between 600 and 86400 seconds.");
        }
        const clone = this.clone();
        clone._sessionTimeoutSecs = seconds;
        return clone;
    }

    /**
     * Set an idempotency key for payment registration.
     *
     * When set, the key is sent as `externalRequestId` to SATIM, which
     * returns the same response for duplicate requests instead of creating
     * a new order. This also enables automatic retries on `register()` and
     * `registerPreAuth()` since retrying is now safe.
     *
     * @param key - Unique string (1-128 chars, alphanumeric/hyphens/underscores).
     *              Use `deriveIdempotencyKey()` to generate deterministic keys from
     *              your internal order reference.
     * @throws SatimInvalidArgumentError if the key format is invalid.
     */
    public idempotencyKey(key: string): this {
        if (!key || !/^[a-zA-Z0-9_\-]{1,128}$/.test(key)) {
            throw new SatimInvalidArgumentError(
                "Idempotency key must be 1-128 characters, alphanumeric, hyphens, or underscores.",
            );
        }
        const clone = this.clone();
        clone._idempotencyKey = key;
        return clone;
    }

    /**
     * Custom JSON serializer that redacts sensitive credentials.
     * Prevents accidental exposure of username/password when the object
     * is serialized (e.g. via JSON.stringify, logging frameworks, or error reporters).
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

    /**
     * Custom inspect handler to prevent credential leakage in console.log / util.inspect.
     */
    public [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
        return this.toJSON();
    }

    public toString(): string {
        return "[SatimConfig credentials=REDACTED]";
    }

    public [Symbol.toPrimitive](): string {
        return this.toString();
    }
}

import type { Language, CurrencyCode, SatimCredentials } from "./types.js";
import { SatimInvalidArgumentError, SatimMissingDataError } from "./exceptions.js";
import { assertSafeUrl } from "./ssrf.js";
import {
    assertRegisterAmount, assertDescription, assertLanguage,
    assertOrderNumber, assertTimeout, assertIdempotencyKey,
    assertUserField, assertCredentialString,
} from "./validation.js";

interface Creds { username: string; password: string; terminalId: string; }

// Credentials live here, off the instance, so Object.keys / JSON.stringify / inspect never expose them.
const _credentials = new WeakMap<SatimConfig, Creds>();

const CURRENCIES: Record<string, CurrencyCode> = { DZD: "012", USD: "840", EUR: "978" };

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

    protected _allowPrivateUrls = false;

    protected get username(): string { return _credentials.get(this)!.username; }

    protected get password(): string { return _credentials.get(this)!.password; }

    protected get terminalId(): string { return _credentials.get(this)!.terminalId; }

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

    // Every setter clones, so a shared base instance can't leak state across concurrent requests.
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
        c._allowPrivateUrls = this._allowPrivateUrls;
        const creds = _credentials.get(this);
        if (creds) _credentials.set(c, { ...creds });
        return c;
    }

    public amount(amount: number): this {
        assertRegisterAmount(amount);
        const c = this.clone(); c._amount = amount; return c;
    }

    public description(description: string): this {
        assertDescription(description);
        const c = this.clone(); c._description = description; return c;
    }

    public currency(curr: "DZD" | "USD" | "EUR"): this {
        const code = CURRENCIES[curr];
        if (!code) throw new SatimInvalidArgumentError("Invalid currency: Allowed currencies are [DZD, USD, EUR].");
        const c = this.clone(); c._currency = code; return c;
    }

    public failUrl(url: string): this {
        assertSafeUrl(url, "Invalid fail URL. Must be a valid http/https URL.", this._allowPrivateUrls);
        const c = this.clone(); c._failUrl = url; return c;
    }

    public returnUrl(url: string): this {
        assertSafeUrl(url, "Invalid return URL. Must be a valid http/https URL.", this._allowPrivateUrls);
        const c = this.clone(); c._returnUrl = url; return c;
    }

    public dynamicCallbackUrl(url: string): this {
        assertSafeUrl(url, "Invalid dynamic callback URL. Must be a valid http/https URL.", this._allowPrivateUrls);
        const c = this.clone(); c._dynamicCallbackUrl = url; return c;
    }

    public orderNumber(orderNumber: string | number): this {
        const str = assertOrderNumber(orderNumber);
        const c = this.clone(); c._orderNumber = str; return c;
    }

    public setTestMode(isEnabled: boolean): this {
        const c = this.clone(); c.testMode = isEnabled; return c;
    }

    public language(lang: Language): this {
        assertLanguage(lang);
        const c = this.clone(); c._language = lang.toUpperCase() as Language; return c;
    }

    public userDefinedField(key: string, value: string): this {
        assertUserField(key, value);
        const c = this.clone(); c._userDefinedFields[key] = value; return c;
    }

    public userDefinedFields(fields: Record<string, string>): this {
        let cur: this = this;
        for (const [k, v] of Object.entries(fields)) cur = cur.userDefinedField(k, v);
        return cur;
    }

    public timeout(seconds: number): this {
        assertTimeout(seconds);
        const c = this.clone(); c._sessionTimeoutSecs = seconds; return c;
    }

    // Dev-only escape hatch for the SSRF guard; call before the URL setters.
    public allowPrivateUrls(enabled: boolean): this {
        const c = this.clone(); c._allowPrivateUrls = enabled === true; return c;
    }

    public idempotencyKey(key: string): this {
        assertIdempotencyKey(key);
        const c = this.clone(); c._idempotencyKey = key; return c;
    }

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

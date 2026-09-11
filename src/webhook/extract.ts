/**
 * Order-ID extraction from heterogeneous webhook source types: a bare
 * string, a URL string, a `Request`-like object, or a plain object.
 *
 * The gateway names the order `mdOrder` in its callbacks — BPC documents
 * the notification URL as
 * `…/callback?mdOrder=…&orderNumber=…&operation=deposited&status=1`, with
 * no `orderId` anywhere. Reading only `orderId` made every real callback
 * unextractable, so both spellings are accepted, `orderId` first.
 *
 * Returns a validated, trimmed string, or `null` if nothing yields a
 * syntactically valid ID (`[a-zA-Z0-9\-]{1,128}`) — this format guard
 * blocks orderIds carrying URL-, log-, or SQL-meaningful characters.
 * @file
 */

/** Query/property names the gateway uses for the order, in priority order. */
const ORDER_KEYS = ["orderId", "mdOrder"] as const;

/** Strict allowed format: alphanumeric and hyphens, 1–128 chars. */
const ORDER_ID_PATTERN = /^[a-zA-Z0-9\-]{1,128}$/;

/**
 * Extract and validate an orderId from any accepted source type. Returns
 * a string matching {@link ORDER_ID_PATTERN}, or `null` — which
 * guarantees `satim.confirm()` never receives an orderId that could
 * carry an injection payload.
 */
export function extractOrderId(source: unknown): string | null {
    if (source === null || source === undefined) return null;
    const raw = fromString(source) ?? fromRequest(source) ?? fromObject(source);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed && ORDER_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Read the first order key present in a URL's query string. */
function fromQuery(url: string): string | undefined {
    const params = new URL(url, "http://localhost").searchParams;
    for (const key of ORDER_KEYS) {
        const value = params.get(key);
        if (value) return value;
    }
    return undefined;
}

/**
 * Strategy 1: string source. URL-like strings (`://` or leading `?`) are
 * parsed and the order read from the query string; other strings pass
 * through verbatim.
 */
function fromString(source: unknown): string | undefined {
    if (typeof source !== "string") return undefined;
    const str = source.trim();
    if (!str.includes("://") && !str.startsWith("?")) return str;
    try {
        return fromQuery(str);
    } catch {
        return str;
    }
}

/**
 * Strategy 2: `Request`-like object. Reads the order from the `url`
 * property's query string; `method`/`body` are ignored.
 */
function fromRequest(source: unknown): string | undefined {
    if (typeof source !== "object" || source === null || !("url" in source)) return undefined;
    const req = source as { url?: string };
    if (typeof req.url !== "string") return undefined;
    try {
        return fromQuery(req.url);
    } catch {
        return undefined;
    }
}

/**
 * Strategy 3: plain object carrying the order (parsed JSON body or query
 * map). Accepts `string` or `number`, coercing numbers.
 */
function fromObject(source: unknown): string | undefined {
    if (typeof source !== "object" || source === null) return undefined;
    const obj = source as Record<string, unknown>;
    for (const key of ORDER_KEYS) {
        const value = obj[key];
        if (typeof value === "string") return value;
        if (typeof value === "number") return String(value);
    }
    return undefined;
}

/**
 * Collect every callback parameter, for checksum verification.
 *
 * Accepts the same source shapes as {@link extractOrderId}: a URL string,
 * a `Request`-like object, or a plain map. Returns `null` when the source
 * carries no parameters to verify.
 */
export function extractParams(source: unknown): Record<string, string> | null {
    const fromUrl = (url: string): Record<string, string> | null => {
        try {
            const params = new URL(url, "http://localhost").searchParams;
            const out: Record<string, string> = {};
            for (const [key, value] of params) out[key] = value;
            return Object.keys(out).length ? out : null;
        } catch {
            return null;
        }
    };

    if (typeof source === "string") {
        return source.includes("://") || source.startsWith("?") ? fromUrl(source) : null;
    }
    if (typeof source !== "object" || source === null) return null;

    const req = source as { url?: unknown };
    if (typeof req.url === "string") return fromUrl(req.url);

    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number") out[key] = String(value);
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Order-ID extraction from heterogeneous webhook source types: a bare
 * string, a URL string, a `Request`-like object, or a plain object with
 * an `orderId` property.
 *
 * Returns a validated, trimmed string, or `null` if nothing yields a
 * syntactically valid ID (`[a-zA-Z0-9\-]{1,128}`) — this format guard
 * blocks orderIds carrying URL-, log-, or SQL-meaningful characters.
 * @file
 */

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

/**
 * Strategy 1: string source. URL-like strings (`://` or leading `?`) are
 * parsed and `orderId` read from the query string; other strings pass
 * through verbatim.
 */
function fromString(source: unknown): string | undefined {
    if (typeof source !== "string") return undefined;
    const str = source.trim();
    if (!str.includes("://") && !str.startsWith("?")) return str;
    try {
        return new URL(str, "http://localhost").searchParams.get("orderId") ?? undefined;
    } catch {
        return str;
    }
}

/**
 * Strategy 2: `Request`-like object. Reads `orderId` from the `url`
 * property's query string; `method`/`body` are ignored.
 */
function fromRequest(source: unknown): string | undefined {
    if (typeof source !== "object" || source === null || !("url" in source)) return undefined;
    const req = source as { url?: string };
    if (typeof req.url !== "string") return undefined;
    try {
        return new URL(req.url, "http://localhost").searchParams.get("orderId") ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Strategy 3: plain object with an `orderId` property (parsed JSON body
 * or query map). Accepts `string` or `number`, coercing numbers.
 */
function fromObject(source: unknown): string | undefined {
    if (typeof source !== "object" || source === null) return undefined;
    const obj = source as Record<string, unknown>;
    if (typeof obj.orderId === "string") return obj.orderId;
    if (typeof obj.orderId === "number") return String(obj.orderId);
    return undefined;
}

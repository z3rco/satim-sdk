/**
 * Order-ID extraction from heterogeneous webhook source types.
 *
 * SATIM callbacks arrive in different shapes depending on how the
 * merchant's framework parses them:
 * - A bare `orderId` string.
 * - A URL string with `?orderId=…`.
 * - A Web API `Request` whose `.url` contains `?orderId=…`.
 * - A plain object with an `orderId` property (parsed JSON body, query map).
 *
 * `extractOrderId` accepts all four and returns a validated, trimmed
 * string — or `null` if the input does not yield a syntactically valid
 * order ID. The strict format match (`[a-zA-Z0-9\-]{1,128}`) defends
 * against orderIds containing URL-, log-, or SQL-meaningful characters
 * that could be abused downstream.
 * @file
 */

/** Strict allowed format: alphanumeric and hyphens, 1–128 chars. */
const ORDER_ID_PATTERN = /^[a-zA-Z0-9\-]{1,128}$/;

/**
 * Extract and validate an orderId from any accepted source type. Returns
 * a string matching {@link ORDER_ID_PATTERN}, or `null` on null/undefined
 * input, no extraction strategy succeeding, or format check failing.
 *
 * Returning `null` for malformed inputs guarantees downstream
 * `satim.confirm(orderId, …)` never sees an orderId that could carry
 * injection payloads through to the gateway.
 */
export function extractOrderId(source: unknown): string | null {
    if (source === null || source === undefined) return null;
    const raw = fromString(source) ?? fromRequest(source) ?? fromObject(source);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed && ORDER_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Strategy 1: string source.
 *
 * Strings that look like URLs (contain `://` or start with `?`) are parsed
 * and `orderId` is extracted from the query string. Other strings are
 * returned verbatim for the final format check.
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
 * Strategy 2: Web API `Request`-like object source.
 *
 * Probes for a `url` property; ignores `method` and `body` (the handler
 * does not consume the body — orderId comes from the URL only).
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
 * or query-string map).
 *
 * Accepts `string` and `number` values for `orderId` (gateways
 * occasionally serialise it as a number); coerces numbers to string for
 * the format check.
 */
function fromObject(source: unknown): string | undefined {
    if (typeof source !== "object" || source === null) return undefined;
    const obj = source as Record<string, unknown>;
    if (typeof obj.orderId === "string") return obj.orderId;
    if (typeof obj.orderId === "number") return String(obj.orderId);
    return undefined;
}

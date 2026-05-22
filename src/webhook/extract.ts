/**
 * Order ID extraction from heterogeneous webhook sources.
 * Accepts: orderId string, URL string, Web Request, or plain object with orderId.
 * @file
 */

const ORDER_ID_PATTERN = /^[a-zA-Z0-9\-]{1,128}$/;

/**
 * Extract and validate an orderId from any accepted source.
 * @returns Validated orderId, or null when missing/invalid.
 */
export function extractOrderId(source: unknown): string | null {
    if (source === null || source === undefined) return null;
    const raw = fromString(source) ?? fromRequest(source) ?? fromObject(source);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed && ORDER_ID_PATTERN.test(trimmed) ? trimmed : null;
}

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

function fromObject(source: unknown): string | undefined {
    if (typeof source !== "object" || source === null) return undefined;
    const obj = source as Record<string, unknown>;
    if (typeof obj.orderId === "string") return obj.orderId;
    if (typeof obj.orderId === "number") return String(obj.orderId);
    return undefined;
}

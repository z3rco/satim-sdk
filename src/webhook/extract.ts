// Gateway callbacks name the order `mdOrder`, not `orderId`; accept both, orderId first.
const ORDER_KEYS = ["orderId", "mdOrder"] as const;

// Strict format: keeps injection payloads out of satim.confirm().
const ORDER_ID_PATTERN = /^[a-zA-Z0-9\-]{1,128}$/;

export function extractOrderId(source: unknown): string | null {
    if (source === null || source === undefined) return null;
    const raw = fromString(source) ?? fromRequest(source) ?? fromObject(source);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed && ORDER_ID_PATTERN.test(trimmed) ? trimmed : null;
}

// Reject callbacks with duplicate query keys: two parsers disagreeing on which value wins is how a signed callback for one order gets replayed against another.
function strictQueryParams(url: string): Record<string, string> | null {
    const params = new URL(url, "http://localhost").searchParams;
    const out: Record<string, string> = {};
    for (const [key, value] of params) {
        if (key in out) return null;
        out[key] = value;
    }
    return out;
}

function fromQuery(url: string): string | undefined {
    const params = strictQueryParams(url);
    if (!params) return undefined;
    for (const key of ORDER_KEYS) {
        if (params[key]) return params[key];
    }
    return undefined;
}

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

export function extractParams(source: unknown): Record<string, string> | null {
    const fromUrl = (url: string): Record<string, string> | null => {
        try {
            const p = strictQueryParams(url);
            return p && Object.keys(p).length ? p : null;
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

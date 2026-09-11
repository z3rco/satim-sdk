import { SatimInvalidArgumentError } from "./exceptions.js";

const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "[::1]",
    "metadata.google.internal",
]);

const PRIVATE_IPV4 = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
];

const PRIVATE_IPV6 = [
    /^::1$/i,
    /^::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/i,
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i,
    /^::ffff:(a[0-9a-f]{0,2}|ac1[0-9a-f]|c0a8|a9fe):[0-9a-f]{1,4}$/i,
    /^::ffff:0:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i,
    /^::ffff:0:(a[0-9a-f]{0,2}):[0-9a-f]{1,4}$/i,
    /^::ffff:0:ac1[0-9a-f]:[0-9a-f]{1,4}$/i,
    /^::ffff:0:c0a8:[0-9a-f]{1,4}$/i,
    /^::ffff:0:a9fe:[0-9a-f]{1,4}$/i,
    /^::ffff:0:[0]{1,4}:[0-9a-f]{1,4}$/i,
    /^64:ff9b::/i,
    /^::7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i,
    /^::(a[0-9a-f]{0,2}):[0-9a-f]{1,4}$/i,
    /^::ac1[0-9a-f]:[0-9a-f]{1,4}$/i,
    /^::c0a8:[0-9a-f]{1,4}$/i,
    /^::a9fe:[0-9a-f]{1,4}$/i,
    /^::[0]{1,4}:[0-9a-f]{1,4}$/i,
    /^f[cd]/i,
    /^fe[89ab]/i,
    /^::$/i,
];

function isNonStandardIp(host: string): boolean {
    return /^\d{4,}$/.test(host)
        || /^0\d+(\.0?\d+)*$/.test(host)
        || /0x[0-9a-f]/i.test(host);
}

function normalizeIpv6(host: string): string | null {
    if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1).toLowerCase();
    if (host.includes(":")) return host.toLowerCase();
    return null;
}

const PRIVATE_HINT =
    "URLs pointing to private/reserved addresses are not allowed. "
    + "For local development call .allowPrivateUrls(true) before setting the URL.";

const MAX_CACHE = 512;
const cache = new Set<string>();

export function isPrivateHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host)) return true;
    if (PRIVATE_IPV4.some((p) => p.test(host))) return true;
    const v6 = normalizeIpv6(host);
    return Boolean(v6 && PRIVATE_IPV6.some((p) => p.test(v6)));
}

export function assertSafeUrl(urlStr: string, errorPrefix: string, allowPrivate = false): void {

    if (cache.has(urlStr)) return;

    let parsed: URL;
    try {
        parsed = new URL(urlStr);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
        throw new SatimInvalidArgumentError(errorPrefix);
    }

    const host = parsed.hostname.toLowerCase();

    if (isNonStandardIp(host)) {
        throw new SatimInvalidArgumentError(`${errorPrefix} Non-standard IP address encodings are not allowed.`);
    }
    if (allowPrivate) return;

    if (BLOCKED_HOSTNAMES.has(host)) {
        throw new SatimInvalidArgumentError(`${errorPrefix} ${PRIVATE_HINT}`);
    }
    if (PRIVATE_IPV4.some((p) => p.test(host))) {
        throw new SatimInvalidArgumentError(`${errorPrefix} ${PRIVATE_HINT}`);
    }
    const v6 = normalizeIpv6(host);
    if (v6 && PRIVATE_IPV6.some((p) => p.test(v6))) {
        throw new SatimInvalidArgumentError(`${errorPrefix} ${PRIVATE_HINT}`);
    }

    if (cache.size >= MAX_CACHE) cache.delete(cache.values().next().value!);
    cache.add(urlStr);
}

/**
 * SSRF URL validation: rejects private/reserved IPv4/IPv6 ranges,
 * non-standard IP encodings (decimal/octal/hex), and known internal hostnames.
 * @file
 */

import { SatimInvalidArgumentError } from "./exceptions";

const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "[::1]",
    "metadata.google.internal",
]);

const PRIVATE_IPV4 = [
    /^127\./,                       // Loopback
    /^10\./,                        // Class A private
    /^172\.(1[6-9]|2\d|3[01])\./,   // Class B private
    /^192\.168\./,                  // Class C private
    /^169\.254\./,                  // Link-local / cloud metadata
    /^0\./,                         // "This" network
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
    /^f[cd]/i,                       // Unique local
    /^fe[89ab]/i,                    // Link-local
    /^::$/i,                         // Unspecified
];

/** Detect decimal/octal/hex IP encodings that bypass naive filters. */
function isNonStandardIp(host: string): boolean {
    return /^\d{4,}$/.test(host)
        || /^0\d+(\.0?\d+)*$/.test(host)
        || /0x[0-9a-f]/i.test(host);
}

/** Extract a normalized IPv6 string from a hostname, or null. */
function normalizeIpv6(host: string): string | null {
    if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1).toLowerCase();
    if (host.includes(":")) return host.toLowerCase();
    return null;
}

const MAX_CACHE = 512;
const cache = new Set<string>();

/**
 * Validate that a URL is http/https and does not target a private/internal host.
 * Caches up to 512 validated URLs to amortize cost across hot paths.
 *
 * @param urlStr URL to validate.
 * @param errorPrefix Prefix included in thrown error messages.
 * @throws SatimInvalidArgumentError on malformed URL or blocked target.
 */
export function assertSafeUrl(urlStr: string, errorPrefix: string): void {
    if (cache.has(urlStr)) return;

    let parsed: URL;
    try {
        parsed = new URL(urlStr);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
        throw new SatimInvalidArgumentError(errorPrefix);
    }

    const host = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host)) {
        throw new SatimInvalidArgumentError(`${errorPrefix} URLs pointing to internal/private hosts are not allowed.`);
    }
    if (isNonStandardIp(host)) {
        throw new SatimInvalidArgumentError(`${errorPrefix} Non-standard IP address encodings are not allowed.`);
    }
    if (PRIVATE_IPV4.some((p) => p.test(host))) {
        throw new SatimInvalidArgumentError(`${errorPrefix} URLs pointing to private/reserved IP ranges are not allowed.`);
    }
    const v6 = normalizeIpv6(host);
    if (v6 && PRIVATE_IPV6.some((p) => p.test(v6))) {
        throw new SatimInvalidArgumentError(`${errorPrefix} URLs pointing to private/reserved IPv6 ranges are not allowed.`);
    }

    if (cache.size >= MAX_CACHE) cache.delete(cache.values().next().value!);
    cache.add(urlStr);
}

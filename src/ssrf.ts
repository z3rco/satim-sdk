/**
 * SSRF URL validation.
 *
 * Rejects URLs whose target could let an attacker pivot through the SDK
 * (or, via callback delivery, through the SATIM gateway) to internal
 * infrastructure. Applied to every URL-bearing setter: `returnUrl`,
 * `failUrl`, `dynamicCallbackUrl`.
 *
 * Reject categories:
 * - Non-HTTP(S) schemes.
 * - Literal blocked hostnames: `localhost`, `[::1]`, `metadata.google.internal`.
 * - Private/reserved IPv4 ranges per RFC 1918, RFC 3927, RFC 6890.
 * - Private/reserved IPv6 ranges (ULA, link-local, IPv4-mapped/translated
 *   variants, NAT64, unspecified).
 * - Non-standard IP encodings (decimal, octal, hex) that bypass naive
 *   string-based filters.
 *
 * **Known limitation:** validation runs at configuration time only. The
 * SDK does not re-resolve DNS at request time, so a host that resolved
 * to a public IP during validation could later resolve to a private IP
 * via DNS rebinding. The SDK itself does not fetch these URLs — they
 * are forwarded to SATIM for callback delivery — so the residual risk
 * transfers to the callback endpoint operator's egress controls.
 * @file
 */

import { SatimInvalidArgumentError } from "./exceptions.js";

/** Literal hostnames always rejected regardless of resolution. */
const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "[::1]",
    "metadata.google.internal",
]);

/** Private/reserved IPv4 patterns. */
const PRIVATE_IPV4 = [
    /^127\./,                       // Loopback (RFC 5735)
    /^10\./,                        // Class A private (RFC 1918)
    /^172\.(1[6-9]|2\d|3[01])\./,   // Class B private (RFC 1918)
    /^192\.168\./,                  // Class C private (RFC 1918)
    /^169\.254\./,                  // Link-local / cloud metadata (RFC 3927)
    /^0\./,                         // "This" network (RFC 1122)
];

/** Private/reserved IPv6 patterns. Match both shorthand and expanded forms. */
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
    /^64:ff9b::/i,                   // NAT64 well-known prefix (RFC 6052)
    /^::7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i,
    /^::(a[0-9a-f]{0,2}):[0-9a-f]{1,4}$/i,
    /^::ac1[0-9a-f]:[0-9a-f]{1,4}$/i,
    /^::c0a8:[0-9a-f]{1,4}$/i,
    /^::a9fe:[0-9a-f]{1,4}$/i,
    /^::[0]{1,4}:[0-9a-f]{1,4}$/i,
    /^f[cd]/i,                       // Unique local (fc00::/7)
    /^fe[89ab]/i,                    // Link-local (fe80::/10)
    /^::$/i,                         // Unspecified
];

/**
 * Detect decimal, octal, or hex IP encodings that bypass naive filters.
 * Examples: `2130706433` (decimal 127.0.0.1), `0177.0.0.1` (octal),
 * `0x7f.0.0.1` (hex).
 */
function isNonStandardIp(host: string): boolean {
    return /^\d{4,}$/.test(host)
        || /^0\d+(\.0?\d+)*$/.test(host)
        || /0x[0-9a-f]/i.test(host);
}

/** Strip brackets and lowercase an IPv6 literal; returns `null` for non-IPv6 hosts. */
function normalizeIpv6(host: string): string | null {
    if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1).toLowerCase();
    if (host.includes(":")) return host.toLowerCase();
    return null;
}

/** Bounded LRU-ish cache. Keeps `assertSafeUrl` near-constant time across hot paths. */
const MAX_CACHE = 512;
const cache = new Set<string>();

/**
 * Validate a URL against the reject categories listed in the file header.
 * Validated URLs are cached (bounded LRU, max {@link MAX_CACHE}).
 *
 * @param urlStr URL to validate.
 * @param errorPrefix Message prefix included verbatim in thrown errors.
 * @throws {@link SatimInvalidArgumentError} when the URL is malformed,
 *         non-HTTP(S), targets a blocked hostname, uses a private IPv4
 *         or IPv6 range, or uses a non-standard IP encoding.
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

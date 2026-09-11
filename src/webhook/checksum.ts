/**
 * Callback checksum verification (symmetric / HMAC-SHA256).
 *
 * BPC can sign callback notifications. When it does, the notification
 * carries a `checksum` parameter and the merchant recomputes it from the
 * other parameters using a secret shared with the gateway:
 *
 * 1. Drop `checksum` and `sign_alias` from the parameters.
 * 2. Sort the rest by parameter name, ascending.
 * 3. Join as `name;value;name;value;…;` — note the trailing semicolon.
 * 4. HMAC-SHA256 that string with the shared secret.
 * 5. Upper-case the hex digest and compare with `checksum`.
 *
 * This proves the notification came from the gateway. It does not prove
 * the notification reflects current state — a replayed callback carries a
 * still-valid signature — so {@link WebhookHandler} keeps re-fetching live
 * state regardless. The two answer different questions and are worth
 * having together.
 *
 * Asymmetric signing (the gateway signs with a private key) is not
 * implemented here; it needs the gateway's public key and a certificate
 * flow that varies per deployment.
 * @file
 */

import { sha256Bytes } from "../crypto.js";

/** Parameters excluded from the signed string, per BPC. */
const EXCLUDED = new Set(["checksum", "sign_alias"]);

const encoder = new TextEncoder();

/**
 * Build the string BPC signs: parameters sorted by name, joined as
 * `name;value;` pairs, with a trailing semicolon.
 *
 * Exported for callers who need to debug a mismatch against the gateway.
 */
export function buildSignedString(params: Record<string, string>): string {
    return Object.keys(params)
        .filter((name) => !EXCLUDED.has(name))
        .sort()
        .map((name) => `${name};${params[name]};`)
        .join("");
}

/**
 * HMAC-SHA256 over raw bytes, per RFC 2104: keys longer than the 64-byte
 * block are hashed first and shorter ones zero-padded, then the inner and
 * outer digests are chained.
 *
 * Built on {@link sha256Bytes} rather than the string digest — the inner
 * and outer blocks are arbitrary bytes, and UTF-8-encoding them would
 * corrupt every byte above 0x7F.
 */
function hmacSha256Hex(secret: string, message: string): string {
    const BLOCK = 64;
    let key: Uint8Array = encoder.encode(secret);
    if (key.length > BLOCK) key = hexToBytes(sha256Bytes(key));

    const innerKey = new Uint8Array(BLOCK);
    const outerKey = new Uint8Array(BLOCK);
    innerKey.set(key);
    outerKey.set(key);
    for (let i = 0; i < BLOCK; i++) {
        innerKey[i] ^= 0x36;
        outerKey[i] ^= 0x5c;
    }

    const innerDigest = hexToBytes(sha256Bytes(concat(innerKey, encoder.encode(message))));
    return sha256Bytes(concat(outerKey, innerDigest));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** Constant-time comparison, so a mismatch leaks no timing information. */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/**
 * Verify a signed callback.
 *
 * @param params Every callback parameter, including `checksum`.
 * @param secret The symmetric key shared with the gateway.
 * @returns `true` when the recomputed checksum matches.
 */
export function verifyCallbackChecksum(params: Record<string, string>, secret: string): boolean {
    const provided = params.checksum;
    if (!provided || !secret) return false;
    const expected = hmacSha256Hex(secret, buildSignedString(params)).toUpperCase();
    return timingSafeEqual(expected, provided.toUpperCase());
}

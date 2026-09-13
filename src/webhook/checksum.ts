import { sha256Bytes } from "../crypto.js";

const EXCLUDED = new Set(["checksum", "sign_alias"]);

const encoder = new TextEncoder();

export function buildSignedString(params: Record<string, string>): string {
    return Object.keys(params)
        .filter((name) => !EXCLUDED.has(name))
        .sort()
        .map((name) => `${name};${params[name]};`)
        .join("");
}

// sha256Bytes, not sha256Hex: the HMAC blocks are raw bytes and UTF-8-encoding them would corrupt anything above 0x7F.
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

// Constant-time so a mismatch leaks no timing.
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// Proves origin only; a replay carries a valid signature, so the handler still re-fetches live state.
export function verifyCallbackChecksum(params: Record<string, string>, secret: string): boolean {
    const provided = params.checksum;
    if (!provided || !secret) return false;
    for (const [name, value] of Object.entries(params)) {
        if (!EXCLUDED.has(name) && (name.includes(";") || value.includes(";"))) return false;
    }
    const expected = hmacSha256Hex(secret, buildSignedString(params)).toUpperCase();
    return timingSafeEqual(expected, provided.toUpperCase());
}

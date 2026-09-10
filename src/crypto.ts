/**
 * Runtime-agnostic cryptographic primitives.
 *
 * The SDK needs exactly two things from a crypto layer: a synchronous
 * SHA-256 (for deterministic idempotency-key and order-number derivation)
 * and a CSPRNG (for default order numbers). Neither is available
 * synchronously from WebCrypto — `crypto.subtle.digest` is async — and
 * `node:crypto` is absent on Vercel Edge and gated behind `nodejs_compat`
 * on Cloudflare Workers.
 *
 * This module therefore ships a compact SHA-256 (FIPS 180-4) implemented
 * on `Uint32Array`, and draws randomness from `crypto.getRandomValues`,
 * which is a global in every runtime the SDK supports (Node ≥ 20, Bun,
 * Deno, Cloudflare Workers, Vercel/Netlify Edge). The result is a package
 * with no `node:` imports at all — importing it never fails on an edge
 * runtime.
 *
 * The digest is used for deriving stable identifiers, never for signing
 * or authenticating anything; correctness against the spec is verified
 * in `tests/crypto.test.ts` by differential-testing every output against
 * `node:crypto`.
 * @file
 */

/** Round constants: first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Rotate a 32-bit word right by `n` bits. */
function rotr(x: number, n: number): number {
    return (x >>> n) | (x << (32 - n));
}

const encoder = new TextEncoder();

/**
 * SHA-256 of a UTF-8 string, lowercase hex.
 *
 * Complexity: O(n) in the byte length of `input`, one pass over each
 * 64-byte block with a reused message schedule.
 *
 * @returns 64 lowercase hex characters.
 */
export function sha256Hex(input: string): string {
    const bytes = encoder.encode(input);
    const bitLen = bytes.length * 8;

    // Pad to a multiple of 64 bytes: 0x80, then zeros, then a 64-bit big-endian bit length.
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLen / 0x1_0000_0000));
    view.setUint32(padded.length - 4, bitLen >>> 0);

    const H = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const W = new Uint32Array(64);

    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const w15 = W[i - 15];
            const w2 = W[i - 2];
            const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
            const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
            W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
        }

        let a = H[0], b = H[1], c = H[2], d = H[3];
        let e = H[4], f = H[5], g = H[6], h = H[7];

        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;

            h = g; g = f; f = e; e = (d + t1) | 0;
            d = c; c = b; b = a; a = (t1 + t2) | 0;
        }

        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
        H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
        H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }

    let out = "";
    for (let i = 0; i < 8; i++) out += H[i].toString(16).padStart(8, "0");
    return out;
}

/** Digits and lowercase letters — the alphabet permitted by SATIM's AN.10 order-number field. */
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Length of every SDK-generated order number. 36^10 ≈ 3.66 × 10^15 distinct values. */
export const ORDER_NUMBER_LENGTH = 10;

/**
 * Largest multiple of 36 that fits in a byte (36 × 7 = 252). Bytes at or
 * above this are discarded so `% 36` stays uniform — a plain `byte % 36`
 * would favour the first four symbols of the alphabet.
 */
const REJECTION_BOUND = 252;

/**
 * Generate a cryptographically random 10-character base-36 order number.
 *
 * Uses `crypto.getRandomValues` with rejection sampling. The 36^10 space
 * puts the 50 % birthday-collision point near 60 million orders, versus
 * ~95 000 for the 10-digit numeric space this replaced.
 *
 * @throws Error when the runtime exposes no Web Crypto global.
 */
export function randomOrderNumber(): string {
    if (typeof globalThis.crypto?.getRandomValues !== "function") {
        throw new Error(
            "No Web Crypto available: crypto.getRandomValues is required to generate order numbers. " +
            "Set an explicit order number with .orderNumber() on this runtime.",
        );
    }
    const out = new Array<string>(ORDER_NUMBER_LENGTH);
    const buf = new Uint8Array(ORDER_NUMBER_LENGTH * 2);
    let filled = 0;
    while (filled < ORDER_NUMBER_LENGTH) {
        globalThis.crypto.getRandomValues(buf);
        for (let i = 0; i < buf.length && filled < ORDER_NUMBER_LENGTH; i++) {
            const byte = buf[i];
            if (byte >= REJECTION_BOUND) continue;
            out[filled++] = BASE36[byte % 36];
        }
    }
    return out.join("");
}

/**
 * Map a hex digest onto a fixed-width base-36 string.
 *
 * Consumes 64 bits of the digest (2^64 ≈ 1.8 × 10^19) and reduces modulo
 * 36^10 ≈ 3.66 × 10^15. The ~5000:1 ratio between the two makes the
 * modulo bias negligible.
 *
 * @param hex A hex digest of at least 16 characters.
 */
export function hexToBase36(hex: string, length: number = ORDER_NUMBER_LENGTH): string {
    const space = 36n ** BigInt(length);
    let value = BigInt(`0x${hex.slice(0, 16)}`) % space;
    let out = "";
    for (let i = 0; i < length; i++) {
        out = BASE36[Number(value % 36n)] + out;
        value /= 36n;
    }
    return out;
}

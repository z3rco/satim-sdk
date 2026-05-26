/**
 * Deterministic key + order-number derivation for idempotent retries.
 *
 * Both functions are pure: the same inputs always produce the same outputs.
 * Callers can derive a key in one process, persist nothing, and recover
 * the same key in a retry process by re-running the derivation with the
 * same merchant reference, amount, and currency.
 *
 * Hash: SHA-256. The derivation inputs are pipe-separated to keep field
 * boundaries explicit; the leading `mode` token provides domain
 * separation between `register` and `preauth` flows so a `register` key
 * cannot collide with a `preauth` key for the same merchantRef.
 * @file
 */

import { createHash } from "node:crypto";
import { toMinorUnits } from "./money";

/** Domain-separation tag distinguishing capture vs hold flows. */
export type Mode = "register" | "preauth";

/**
 * Derive a deterministic, collision-resistant idempotency key.
 *
 * The key is sent to SATIM as `externalRequestId`. The gateway
 * deduplicates registrations sharing the same `externalRequestId`,
 * making retries safe — the second request returns the original order
 * rather than creating a duplicate.
 *
 * Returns a 67-character string of the form `dk_<64 hex chars>`. Same
 * inputs always produce the same output.
 *
 * Security: the merchant reference is **not** escaped before being
 * concatenated. Collisions are possible in principle for adversarially
 * constructed references containing pipe characters that happen to
 * realign field boundaries. The practical impact is bounded —
 * a collision causes the second request to be deduplicated to the first,
 * meaning the merchant believes they registered two orders but the
 * gateway only sees one. Callers controlling untrusted merchantRef
 * content should constrain it to a safe character set (e.g. UUIDs or
 * `[A-Za-z0-9_-]+`).
 *
 * @throws Error when `merchantRef` is missing or empty.
 * @throws Error from {@link toMinorUnits} on invalid `amount`.
 */
export function deriveIdempotencyKey(params: {
    merchantRef: string;
    amount: number;
    currency?: string;
    mode?: Mode;
}): string {
    if (!params.merchantRef?.trim()) {
        throw new Error("deriveIdempotencyKey: merchantRef is required.");
    }
    if (!Number.isFinite(params.amount) || params.amount <= 0) {
        throw new Error("deriveIdempotencyKey: amount must be a finite positive number.");
    }
    const mode = params.mode ?? "register";
    const minor = toMinorUnits(params.amount);
    const input = `${mode}|${params.merchantRef.trim()}|${minor}|${params.currency ?? "012"}`;
    return `dk_${createHash("sha256").update(input).digest("hex")}`;
}

/**
 * Derive a stable 10-digit SATIM order number from a merchant reference.
 *
 * Maps the first 48 bits of SHA-256 into the inclusive-exclusive range
 * `[1_000_000_000, 10_000_000_000)`, satisfying SATIM's `orderNumber`
 * format constraint (AN.10). Same inputs always produce the same output.
 *
 * Modulo bias: `2^48 mod 9_000_000_000 ≠ 0`, so output values are not
 * perfectly uniform. The bias is ~3% (some 10-digit numbers appear 32
 * times across the 2^48 input space while others appear 31). Acceptable
 * for order-number derivation; not suitable for cryptographic primitives.
 */
export function deriveOrderNumber(
    merchantRef: string,
    currency: string = "012",
    mode: Mode = "register",
): string {
    const input = `ordnum|${mode}|${merchantRef.trim()}|${currency}`;
    const hash = createHash("sha256").update(input).digest("hex");
    const raw = parseInt(hash.slice(0, 12), 16);
    return String(1_000_000_000 + (raw % 9_000_000_000));
}

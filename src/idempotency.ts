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

import { sha256Hex, hexToBase36, ORDER_NUMBER_LENGTH } from "./crypto.js";
import { toMinorUnits } from "./money.js";

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
    return `dk_${sha256Hex(input)}`;
}

/**
 * Derive a stable 10-character SATIM order number from a merchant reference.
 *
 * Maps 64 bits of SHA-256 onto a 10-character base-36 string (digits and
 * lowercase letters), satisfying SATIM's `orderNumber` format constraint
 * (AN.10 — alphanumeric, 10 characters). Same inputs always produce the
 * same output.
 *
 * # Collision resistance
 *
 * The output space is `36^10 ≈ 3.66 × 10^15`, putting the 50 %
 * birthday-collision point near 60 million distinct merchant references.
 * The previous 10-*digit* encoding had a `9 × 10^9` space, where the same
 * point falls at roughly 95 000 references — a merchant processing a few
 * hundred orders a day would hit a collision within a year, and a
 * collision here is not benign: two different orders derive the same
 * `orderNumber`, the gateway rejects the second as a duplicate
 * (`ErrorCode: "1"`), and the caller receives a
 * {@link SatimDuplicateOrderError} pointing at an order they never placed.
 *
 * If your SATIM terminal is provisioned to accept numeric order numbers
 * only, set one explicitly with `.orderNumber()` instead of relying on
 * this derivation.
 */
export function deriveOrderNumber(
    merchantRef: string,
    currency: string = "012",
    mode: Mode = "register",
): string {
    const input = `ordnum|${mode}|${merchantRef.trim()}|${currency}`;
    return hexToBase36(sha256Hex(input), ORDER_NUMBER_LENGTH);
}

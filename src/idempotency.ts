/**
 * Deterministic key + order-number derivation for idempotent retries.
 *
 * Both functions are pure (SHA-256 over pipe-separated inputs), so a
 * retry process can recover the same key by re-deriving it from the same
 * merchant reference, amount, and currency — nothing needs to be
 * persisted. A leading `mode` token domain-separates `register` from
 * `preauth` so their keys never collide for the same merchantRef.
 * @file
 */

import { sha256Hex, hexToBase36, ORDER_NUMBER_LENGTH } from "./crypto.js";
import { toMinorUnits } from "./money.js";

/** Domain-separation tag distinguishing capture vs hold flows. */
export type Mode = "register" | "preauth";

/**
 * Derive a deterministic idempotency key, sent to SATIM as
 * `externalRequestId`; the gateway deduplicates registrations sharing it,
 * so a retry returns the original order instead of a duplicate. Returns
 * `dk_<64 hex chars>`.
 *
 * `merchantRef` is not escaped: pipe characters in it can realign field
 * boundaries and collide, so constrain untrusted values (e.g. to UUIDs).
 * @throws Error when `merchantRef` is missing/empty, or from {@link toMinorUnits} on invalid `amount`.
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
 * Derive a stable 10-character SATIM order number (AN.10) from a
 * merchant reference, by mapping 64 bits of SHA-256 onto base-36.
 *
 * The `36^10 ≈ 3.66 × 10^15` space puts the 50% collision point near 60M
 * references, versus ~95,000 for the old 10-digit space it replaced. A
 * collision makes the gateway reject the second order as a duplicate
 * (`ErrorCode: "1"`). If your terminal requires numeric-only order
 * numbers, set one explicitly with `.orderNumber()` instead.
 */
export function deriveOrderNumber(
    merchantRef: string,
    currency: string = "012",
    mode: Mode = "register",
): string {
    const input = `ordnum|${mode}|${merchantRef.trim()}|${currency}`;
    return hexToBase36(sha256Hex(input), ORDER_NUMBER_LENGTH);
}

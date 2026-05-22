/**
 * Deterministic idempotency key + order number derivation.
 * Same inputs always produce the same outputs, making retries safe.
 * @file
 */

import { createHash } from "node:crypto";
import { toMinorUnits } from "./money";

type Mode = "register" | "preauth";

/**
 * Derive a collision-resistant idempotency key from payment parameters.
 *
 * @param params.merchantRef Internal order/cart/invoice ID.
 * @param params.amount Major-unit payment amount.
 * @param params.currency ISO numeric code, default "012" (DZD).
 * @param params.mode "register" (default) or "preauth" — domain separation.
 * @returns Hex digest prefixed with "dk_".
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
 * Derive a stable 10-digit order number from a merchant reference.
 * Maps the first 48 bits of SHA-256 into the 1_000_000_000–9_999_999_999 range.
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

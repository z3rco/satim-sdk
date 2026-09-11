import { sha256Hex, hexToBase36, ORDER_NUMBER_LENGTH } from "./crypto.js";
import { toMinorUnits } from "./money.js";

export type Mode = "register" | "preauth";

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

export function deriveOrderNumber(
    merchantRef: string,
    currency: string = "012",
    mode: Mode = "register",
): string {
    const input = `ordnum|${mode}|${merchantRef.trim()}|${currency}`;
    return hexToBase36(sha256Hex(input), ORDER_NUMBER_LENGTH);
}

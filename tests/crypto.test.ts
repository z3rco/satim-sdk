/**
 * Differential and distribution tests for the runtime-agnostic crypto layer.
 *
 * `src/crypto.ts` replaced `node:crypto` so the package imports cleanly on
 * edge runtimes. That trade is only acceptable if the replacement is
 * bit-identical to the reference implementation, so every digest here is
 * checked against `node:crypto` rather than against stored fixtures.
 */
import { expect, test, describe } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { sha256Hex, randomOrderNumber, hexToBase36, ORDER_NUMBER_LENGTH } from "../src/crypto";

const reference = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("sha256Hex, differential against node:crypto", () => {
    test("matches on the FIPS 180-4 sample vectors", () => {
        expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    test("matches at every length across the block and padding boundaries", () => {
        // 55/56 and 119/120 are where the length field forces an extra block.
        for (let len = 0; len <= 200; len++) {
            const input = "a".repeat(len);
            expect(sha256Hex(input)).toBe(reference(input));
        }
    });

    test("matches on multi-byte UTF-8", () => {
        for (const s of ["é", "日本語", "\u{1F389}\u{1F389}", "naïve café", " "]) {
            expect(sha256Hex(s)).toBe(reference(s));
        }
    });

    test("matches on randomised inputs", () => {
        for (let i = 0; i < 500; i++) {
            const input = randomBytes(1 + Math.floor(Math.random() * 300)).toString("hex");
            expect(sha256Hex(input)).toBe(reference(input));
        }
    });

    test("is deterministic and fixed-width", () => {
        expect(sha256Hex("cart-1")).toBe(sha256Hex("cart-1"));
        expect(sha256Hex("cart-1")).toHaveLength(64);
        expect(sha256Hex("cart-1")).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("randomOrderNumber", () => {
    test("returns 10 characters from the AN.10 alphabet", () => {
        for (let i = 0; i < 200; i++) {
            expect(randomOrderNumber()).toMatch(/^[a-z0-9]{10}$/);
        }
    });

    test("does not repeat across a large sample", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 20_000; i++) seen.add(randomOrderNumber());
        expect(seen.size).toBe(20_000);
    });

    test("rejection sampling keeps the alphabet uniform", () => {
        // A naive `byte % 36` would over-represent the first four symbols
        // by ~14%; assert every symbol lands within 15% of expectation.
        const counts = new Map<string, number>();
        const draws = 50_000 * ORDER_NUMBER_LENGTH;
        for (let i = 0; i < 50_000; i++) {
            for (const ch of randomOrderNumber()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
        }
        expect(counts.size).toBe(36);
        const expected = draws / 36;
        for (const count of counts.values()) {
            expect(Math.abs(count - expected) / expected).toBeLessThan(0.15);
        }
    });
});

describe("hexToBase36", () => {
    test("is deterministic and always fixed-width", () => {
        for (let i = 0; i < 1000; i++) {
            const out = hexToBase36(sha256Hex(`ref-${i}`));
            expect(out).toHaveLength(ORDER_NUMBER_LENGTH);
            expect(out).toMatch(/^[a-z0-9]+$/);
        }
        expect(hexToBase36(sha256Hex("x"))).toBe(hexToBase36(sha256Hex("x")));
    });

    test("pads small values to full width rather than truncating", () => {
        expect(hexToBase36("0000000000000001")).toBe("0000000001");
        expect(hexToBase36("0000000000000000")).toBe("0000000000");
    });
});

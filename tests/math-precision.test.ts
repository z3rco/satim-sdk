import { expect, test, describe } from "vitest";
import { toMinorUnits, hasSubCentimePrecision, isWholeMinorUnits, MAX_SAFE_AMOUNT } from "../src/utils";
import { ConfirmResponse } from "../src/responses";

describe("toMinorUnits — IEEE 754 stress tests", () => {
    test("all known problematic IEEE 754 currency values convert correctly", () => {
        const cases: [number, number][] = [
            [0.01, 1], [0.02, 2], [0.03, 3], [0.04, 4], [0.05, 5],
            [0.06, 6], [0.07, 7], [0.08, 8], [0.09, 9], [0.10, 10],
            [0.11, 11], [0.12, 12], [0.13, 13], [0.14, 14], [0.15, 15],
            [0.20, 20], [0.25, 25], [0.30, 30], [0.33, 33], [0.49, 49],
            [0.50, 50], [0.51, 51], [0.66, 66], [0.75, 75], [0.99, 99],
            [1.01, 101], [1.03, 103], [1.10, 110], [1.50, 150], [1.99, 199],
            [3.33, 333], [9.99, 999], [10.01, 1001], [10.10, 1010],
            [19.99, 1999], [29.99, 2999], [35.76, 3576], [49.95, 4995],
            [99.99, 9999], [100.01, 10001], [199.99, 19999],
            [999.99, 99999], [1500.50, 150050], [9999.99, 999999],
        ];
        for (const [input, expected] of cases) {
            expect(toMinorUnits(input)).toBe(expected);
        }
    });

    test("exhaustive: every cent from 0.01 to 100.00 converts correctly", () => {
        for (let cents = 1; cents <= 10_000; cents++) {
            const amount = cents / 100;
            expect(toMinorUnits(amount)).toBe(cents);
        }
    });

    test("whole dollar amounts 1 to 10000 convert correctly", () => {
        for (let d = 1; d <= 10_000; d++) {
            expect(toMinorUnits(d)).toBe(d * 100);
        }
    });

    test("large values with cents convert correctly", () => {
        const bases = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000, 9_999_999_999];
        for (const base of bases) {
            for (const cents of [0, 1, 25, 50, 75, 99]) {
                const amount = base + cents / 100;
                if (amount > MAX_SAFE_AMOUNT) continue;
                expect(toMinorUnits(amount)).toBe(base * 100 + cents);
            }
        }
    });

    test("MAX_SAFE_AMOUNT boundary is exact", () => {
        expect(toMinorUnits(9_999_999_999.99)).toBe(999_999_999_999);
        expect(toMinorUnits(9_999_999_999.98)).toBe(999_999_999_998);
        expect(toMinorUnits(9_999_999_999.01)).toBe(999_999_999_901);
        expect(toMinorUnits(9_999_999_999.00)).toBe(999_999_999_900);
    });

    test("rejects values above MAX_SAFE_AMOUNT", () => {
        expect(() => toMinorUnits(10_000_000_000)).toThrow();
        expect(() => toMinorUnits(10_000_000_000.01)).toThrow();
        expect(() => toMinorUnits(Number.MAX_SAFE_INTEGER)).toThrow();
    });

    test("rejects non-finite and non-positive values", () => {
        expect(() => toMinorUnits(0)).toThrow();
        expect(() => toMinorUnits(-1)).toThrow();
        expect(() => toMinorUnits(-0.01)).toThrow();
        expect(() => toMinorUnits(NaN)).toThrow();
        expect(() => toMinorUnits(Infinity)).toThrow();
        expect(() => toMinorUnits(-Infinity)).toThrow();
    });

    test("rejects sub-centime precision", () => {
        expect(() => toMinorUnits(1.005)).toThrow();
        expect(() => toMinorUnits(19.999)).toThrow();
        expect(() => toMinorUnits(0.001)).toThrow();
        expect(() => toMinorUnits(0.009)).toThrow();
        expect(() => toMinorUnits(100.123)).toThrow();
    });
});

describe("hasSubCentimePrecision — detection correctness", () => {
    test("returns false for exact 2-decimal values", () => {
        const exact = [0.01, 0.02, 0.05, 0.10, 0.25, 0.33, 0.50, 0.75, 0.99,
            1.00, 1.01, 1.50, 1.99, 10.10, 19.99, 100.00, 100.50, 999.99];
        for (const val of exact) {
            expect(hasSubCentimePrecision(val)).toBe(false);
        }
    });

    test("returns true for 3+ decimal place values", () => {
        const subCentime = [0.001, 0.005, 0.009, 1.005, 1.015, 19.999, 100.005, 0.123];
        for (const val of subCentime) {
            expect(hasSubCentimePrecision(val)).toBe(true);
        }
    });

    test("handles IEEE 754 arithmetic artifacts gracefully", () => {
        // 0.1 + 0.2 = 0.30000000000000004 in IEEE 754
        // The toPrecision(12) pipeline absorbs this error, returning false.
        // This is CORRECT behavior: the value converts to 30 centimes (the intended result).
        const val = 0.1 + 0.2;
        expect(hasSubCentimePrecision(val)).toBe(false);
        expect(toMinorUnits(val)).toBe(30); // Correct: 0.30 DZD = 30 centimes
    });
});

describe("isWholeMinorUnits — validation correctness", () => {
    test("accepts valid positive integers", () => {
        expect(isWholeMinorUnits(1)).toBe(true);
        expect(isWholeMinorUnits(100)).toBe(true);
        expect(isWholeMinorUnits(999999999999)).toBe(true);
    });

    test("rejects zero, negatives, non-integers, non-finite", () => {
        expect(isWholeMinorUnits(0)).toBe(false);
        expect(isWholeMinorUnits(-1)).toBe(false);
        expect(isWholeMinorUnits(1.5)).toBe(false);
        expect(isWholeMinorUnits(NaN)).toBe(false);
        expect(isWholeMinorUnits(Infinity)).toBe(false);
        expect(isWholeMinorUnits(-Infinity)).toBe(false);
    });
});

describe("getAmount — minor-to-major round trip", () => {
    test("small minor units convert correctly", () => {
        const cases: [number, number][] = [
            [1, 0.01], [3, 0.03], [7, 0.07], [10, 0.10], [33, 0.33],
            [99, 0.99], [100, 1.00], [101, 1.01], [199, 1.99],
            [1999, 19.99], [3576, 35.76], [9999, 99.99],
        ];
        for (const [minor, expectedMajor] of cases) {
            const response = new ConfirmResponse({ OrderStatus: "2", Amount: String(minor) } as any);
            expect(response.getAmount()).toBe(expectedMajor);
        }
    });

    test("large minor units convert correctly", () => {
        const cases: [number, number][] = [
            [10000, 100], [10001, 100.01], [99999, 999.99],
            [999999, 9999.99], [999999999999, 9999999999.99],
        ];
        for (const [minor, expectedMajor] of cases) {
            const response = new ConfirmResponse({ OrderStatus: "2", Amount: String(minor) } as any);
            expect(response.getAmount()).toBe(expectedMajor);
        }
    });

    test("full round trip: major -> minor -> major preserves value", () => {
        for (let cents = 1; cents <= 10_000; cents++) {
            const originalMajor = cents / 100;
            const minor = toMinorUnits(originalMajor);
            const response = new ConfirmResponse({ OrderStatus: "2", Amount: String(minor) } as any);
            const recovered = response.getAmount()!;
            expect(toMinorUnits(recovered)).toBe(cents);
        }
    });

    test("rejects non-numeric, negative, zero, and fractional amounts", () => {
        expect(new ConfirmResponse({ OrderStatus: "2", Amount: "INVALID" } as any).getAmount()).toBeUndefined();
        expect(new ConfirmResponse({ OrderStatus: "2", Amount: "-100" } as any).getAmount()).toBeUndefined();
        expect(new ConfirmResponse({ OrderStatus: "2", Amount: "0" } as any).getAmount()).toBeUndefined();
        expect(new ConfirmResponse({ OrderStatus: "2", Amount: "10.5" } as any).getAmount()).toBeUndefined();
        expect(new ConfirmResponse({ OrderStatus: "2", Amount: "0x7CF" } as any).getAmount()).toBeUndefined();
        expect(new ConfirmResponse({ OrderStatus: "2", Amount: "" } as any).getAmount()).toBeUndefined();
    });
});

describe("verifyAmount — strict comparison", () => {
    test("matches when gateway and expected amounts agree", () => {
        const cases: [string, number][] = [
            ["1", 0.01], ["100", 1.00], ["1999", 19.99],
            ["50000", 500], ["999999999999", 9999999999.99],
        ];
        for (const [gatewayAmount, expected] of cases) {
            const response = new ConfirmResponse({ OrderStatus: "2", Amount: gatewayAmount } as any);
            expect(() => response.verifyAmount(expected)).not.toThrow();
        }
    });

    test("throws on mismatch", () => {
        const response = new ConfirmResponse({ OrderStatus: "2", Amount: "9999" } as any);
        expect(() => response.verifyAmount(100)).toThrow("mismatch");
    });

    test("rejects hex, scientific, and non-decimal gateway strings", () => {
        const badStrings = ["0x7CF", "1e3", "1E3", "+1999", "-1999", "NaN", "Infinity", "1999.5", "1999.01"];
        for (const str of badStrings) {
            const response = new ConfirmResponse({ OrderStatus: "2", Amount: str } as any);
            expect(() => response.verifyAmount(19.99)).toThrow();
        }
    });

    test("accepts integral minor units serialised with trailing zeros", () => {
        // Gateways routinely push integers through a decimal formatter.
        // Rejecting these threw on perfectly good successful payments.
        for (const str of ["1999.0", "1999.00", "1999.000"]) {
            const response = new ConfirmResponse({ OrderStatus: "2", Amount: str } as any);
            expect(() => response.verifyAmount(19.99)).not.toThrow();
            expect(response.getAmount()).toBe(19.99);
        }
    });

    test("throws when gateway amount is missing", () => {
        const response = new ConfirmResponse({ OrderStatus: "2" } as any);
        expect(() => response.verifyAmount(50)).toThrow("missing amount");
    });

    test("throws when gateway amount is zero", () => {
        const response = new ConfirmResponse({ OrderStatus: "2", Amount: "0" } as any);
        expect(() => response.verifyAmount(50)).toThrow();
    });
});

describe("MAX_SAFE_AMOUNT — boundary precision", () => {
    test("MAX_SAFE_AMOUNT is exactly 9_999_999_999.99", () => {
        expect(MAX_SAFE_AMOUNT).toBe(9_999_999_999.99);
    });

    test("toPrecision(12) is exact at the boundary", () => {
        const atBoundary = 9_999_999_999.99 * 100;
        expect(parseFloat(atBoundary.toPrecision(12))).toBe(999_999_999_999);
    });

    test("toPrecision(12) loses precision beyond boundary", () => {
        // 10_000_000_000.01 * 100 should have 13 significant digits
        // toPrecision(12) truncates to 12, losing the last digit
        const beyondBoundary = 10_000_000_000.01 * 100;
        const rounded = Math.round(parseFloat(beyondBoundary.toPrecision(12)));
        expect(rounded).not.toBe(1_000_000_000_001); // Proves the boundary is needed
    });

    test("all minor unit results fit within Number.MAX_SAFE_INTEGER", () => {
        const maxMinor = toMinorUnits(MAX_SAFE_AMOUNT);
        expect(maxMinor).toBeLessThan(Number.MAX_SAFE_INTEGER);
    });
});

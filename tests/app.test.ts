import { expect, test, describe, vi } from "vitest";
import { Satim, SatimMissingDataError, SatimInvalidArgumentError, SatimGatewayError, SatimUnexpectedResponseError } from "../src";

describe("Satim - credential validation", () => {
    test("throws when credentials are missing", () => {
        expect(() => new Satim({} as any)).toThrow(SatimInvalidArgumentError);
        expect(() => new Satim({ username: "a", password: "b" } as any)).toThrow(SatimInvalidArgumentError);
    });

    test("throws when credentials are non-string types", () => {
        expect(() => new Satim({ username: 123, password: "b", terminalId: "t" } as any)).toThrow(SatimInvalidArgumentError);
        expect(() => new Satim({ username: "a", password: { trim: () => "x" }, terminalId: "t" } as any)).toThrow(SatimInvalidArgumentError);
    });

    test("throws when credentials are empty after trimming", () => {
        expect(() => new Satim({ username: "  ", password: "p", terminalId: "t" })).toThrow(SatimMissingDataError);
    });
});

describe("Satim - input validation", () => {
    const make = () => new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects negative, zero, and below-minimum amounts", () => {
        const satim = make();
        expect(() => satim.amount(0)).toThrow(SatimInvalidArgumentError);
        expect(() => satim.amount(-10)).toThrow(SatimInvalidArgumentError);
        expect(() => satim.amount(10.5)).toThrow(SatimInvalidArgumentError);
        expect((satim.amount(100) as any)._amount).toBe(100);
    });

    test("rejects unsupported language codes", () => {
        const satim = make();
        expect(() => satim.language("ES" as any)).toThrow(SatimInvalidArgumentError);
        expect(satim.language("AR")).not.toBe(satim);
    });
});

describe("Satim - register()", () => {
    test("sends correct payload and stores response", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });

        const mockRequest = vi.fn(async (_endpoint: string, _data: any) => ({
            errorCode: "0",
            orderId: "mock123",
            formUrl: "https://test.satim.dz/payment/form",
        }));

        (satim as any).httpClientService = { handleApiRequest: mockRequest };

        const request = satim
            .amount(500)
            .returnUrl("https://example.com/success")
            .description("Test Description")
            .userDefinedField("custom", "val");

        const response = await request.register();

        expect(mockRequest).toHaveBeenCalled();

        const [endpoint, sentData] = mockRequest.mock.calls[0];
        expect(endpoint).toBe("/register.do");
        expect(sentData.userName).toBe("u");
        expect(sentData.password).toBe("p");
        expect(sentData.amount).toBe(50000);
        expect(sentData.returnUrl).toBe("https://example.com/success");
        expect(sentData.description).toBe("Test Description");

        const jsonParams = JSON.parse(sentData.jsonParams);
        expect(jsonParams.force_terminal_id).toBe("t");
        expect(jsonParams.custom).toBe("val");

        expect(response.getOrderId()).toBe("mock123");
        expect(response.getUrl()).toBe("https://test.satim.dz/payment/form");
    });

    test("protects force_terminal_id from being overridden by userDefinedFields", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "protected_tid" });

        const mockRequest = vi.fn(async (_endpoint: string, _data: any) => ({
            errorCode: "0",
            orderId: "mock123",
            formUrl: "url",
        }));

        (satim as any).httpClientService = { handleApiRequest: mockRequest };

        // Attempting to set force_terminal_id via userDefinedField should now throw
        expect(() =>
            satim.amount(100).returnUrl("https://a.com")
                .userDefinedField("force_terminal_id", "malicious_tid")
        ).toThrow(SatimInvalidArgumentError);
    });
});

describe("Satim - confirm() status predicates", () => {
    test("correctly identifies a successful transaction", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });

        const mockRequest = vi.fn(async () => ({
            OrderStatus: "2",
            Amount: "10000",
            params: { respCode_desc: "Approved" },
        }));

        (satim as any).httpClientService = { handleApiRequest: mockRequest };

        const response = await satim.confirm("mock123", 100);

        expect(response.isSuccessful()).toBe(true);
        expect(response.isFailed()).toBe(false);
        expect(response.getSuccessMessage()).toBe("Approved");
    });
});

describe("Satim - payment verification accessors", () => {
    test("correctly parses Amount and OrderNumber from confirm response", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });

        const mockRequest = vi.fn(async () => ({
            OrderStatus: "2",
            Amount: "15000",
            OrderNumber: "0000000123",
        }));

        (satim as any).httpClientService = { handleApiRequest: mockRequest };

        const response = await satim.confirm("mock123", 150);

        expect(response.getAmount()).toBe(150);
        expect(response.getOrderNumber()).toBe("0000000123");
    });

    test("handles lowercase amount and orderNumber from confirm response", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });

        const mockRequest = vi.fn(async () => ({
            OrderStatus: "2",
            amount: 5000,
            orderNumber: "1234567890",
        }));

        (satim as any).httpClientService = { handleApiRequest: mockRequest };

        const response = await satim.confirm("mock123", 50);

        expect(response.getAmount()).toBe(50);
        expect(response.getOrderNumber()).toBe("1234567890");
    });

    test("verifyAmount throws on mismatch", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });

        const mockRequest = vi.fn(async () => ({
            OrderStatus: "2",
            amount: 5000,
        }));

        (satim as any).httpClientService = { handleApiRequest: mockRequest };

        await expect(satim.confirm("mock123", 100)).rejects.toThrow(SatimUnexpectedResponseError);
    });
});

describe("Satim - SSRF protection", () => {
    const make = () => new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects localhost URLs", () => {
        expect(() => make().returnUrl("http://localhost/callback")).toThrow(SatimInvalidArgumentError);
        expect(() => make().failUrl("https://localhost:3000/fail")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects private IP ranges", () => {
        expect(() => make().returnUrl("http://127.0.0.1/callback")).toThrow(SatimInvalidArgumentError);
        expect(() => make().returnUrl("http://10.0.0.1/callback")).toThrow(SatimInvalidArgumentError);
        expect(() => make().returnUrl("http://192.168.1.1/callback")).toThrow(SatimInvalidArgumentError);
        expect(() => make().returnUrl("http://172.16.0.1/callback")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects cloud metadata endpoint", () => {
        expect(() => make().returnUrl("http://169.254.169.254/latest/meta-data/")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects IPv6 mapped private IPs", () => {
        expect(() => make().returnUrl("http://[::ffff:127.0.0.1]/callback")).toThrow(SatimInvalidArgumentError);
        expect(() => make().returnUrl("http://[::ffff:10.0.0.1]/callback")).toThrow(SatimInvalidArgumentError);
        expect(() => make().returnUrl("http://[::ffff:192.168.1.1]/callback")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects IPv6 unique-local and link-local addresses", () => {
        expect(() => make().returnUrl("http://[fc00::1]/callback")).toThrow(SatimInvalidArgumentError);
        expect(() => make().returnUrl("http://[fd00::1]/callback")).toThrow(SatimInvalidArgumentError);
        expect(() => make().returnUrl("http://[fe80::1]/callback")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects decimal/octal/hex encoded IPs", () => {
        expect(() => make().returnUrl("http://2130706433/callback")).toThrow(SatimInvalidArgumentError);
        expect(() => make().returnUrl("http://0177.0.0.1/callback")).toThrow(SatimInvalidArgumentError);
        expect(() => make().returnUrl("http://0x7f.0.0.1/callback")).toThrow(SatimInvalidArgumentError);
    });

    test("allows valid public URLs", () => {
        expect(() => make().returnUrl("https://example.com/callback")).not.toThrow();
        expect(() => make().returnUrl("https://pay.mysite.dz/success")).not.toThrow();
    });
});

describe("Satim - credential redaction", () => {
    test("toJSON redacts username, password, and terminalId", () => {
        const satim = new Satim({ username: "secret_user", password: "secret_pass", terminalId: "secret_tid" });
        const json = satim.toJSON();
        expect(json.username).toBe("[REDACTED]");
        expect(json.password).toBe("[REDACTED]");
        expect(json.terminalId).toBe("[REDACTED]");
    });

    test("JSON.stringify does not leak credentials", () => {
        const satim = new Satim({ username: "secret_user", password: "secret_pass", terminalId: "secret_tid" });
        const str = JSON.stringify(satim);
        expect(str).not.toContain("secret_user");
        expect(str).not.toContain("secret_pass");
        expect(str).not.toContain("secret_tid");
    });

    test("credentials are not accessible via property enumeration or descriptors", () => {
        const satim = new Satim({ username: "secret_user", password: "secret_pass", terminalId: "secret_tid" });
        // WeakMap credentials should not appear as own properties
        expect(Object.keys(satim)).not.toContain("username");
        expect(Object.keys(satim)).not.toContain("password");
        expect(Object.keys(satim)).not.toContain("terminalId");
        expect(Object.getOwnPropertyDescriptor(satim, "username")?.value).toBeUndefined();
        expect(Object.getOwnPropertyDescriptor(satim, "password")?.value).toBeUndefined();
    });
});

describe("Satim - userDefinedField key validation", () => {
    const make = () => new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects purely numeric keys", () => {
        expect(() => make().userDefinedField("123", "val")).toThrow(SatimInvalidArgumentError);
        expect(() => make().userDefinedField("0", "val")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects empty keys", () => {
        expect(() => make().userDefinedField("", "val")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects reserved keys", () => {
        expect(() => make().userDefinedField("force_terminal_id", "val")).toThrow(SatimInvalidArgumentError);
    });

    test("allows valid string keys including hex-like and scientific notation strings", () => {
        expect(() => make().userDefinedField("0x1f", "val")).not.toThrow();
        expect(() => make().userDefinedField("1e2", "val")).not.toThrow();
        expect(() => make().userDefinedField("Infinity", "val")).not.toThrow();
        expect(() => make().userDefinedField("myField", "val")).not.toThrow();
    });
});

describe("Satim - clone() credential isolation", () => {
    test("cloned instances preserve credential access via getters", () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        const cloned = satim.amount(100);

        // Credentials should not be own properties (they are in a WeakMap)
        expect(Object.getOwnPropertyDescriptor(cloned, "username")?.value).toBeUndefined();
        expect(Object.getOwnPropertyDescriptor(cloned, "password")?.value).toBeUndefined();
    });
});

describe("Satim - NaN amount handling", () => {
    test("confirm rejects non-numeric gateway amount via verifyAmount on success", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        const mockRequest = vi.fn(async () => ({
            OrderStatus: "2",
            Amount: "N/A",
        }));
        (satim as any).httpClientService = { handleApiRequest: mockRequest };
        await expect(satim.confirm("mock123", 50)).rejects.toThrow(SatimUnexpectedResponseError);
    });

    test("confirm returns response without throwing when payment failed", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        const mockRequest = vi.fn(async () => ({
            OrderStatus: "0",
        }));
        (satim as any).httpClientService = { handleApiRequest: mockRequest };
        const response = await satim.confirm("mock123", 50);
        expect(response.isSuccessful()).toBe(false);
        expect(response.isPending()).toBe(true);
    });

    test("getAmount returns undefined for non-numeric gateway values", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "2", Amount: "INVALID" } as any);
        expect(response.getAmount()).toBeUndefined();
    });
});

describe("Satim - orderId validation", () => {
    test("rejects whitespace-only order IDs", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        await expect(satim.confirm("   ", 100)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.status("   ")).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.reverseOrder("")).rejects.toThrow(SatimInvalidArgumentError);
    });

    test("rejects invalid orderId formats", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        await expect(satim.status("order<script>")).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.status("a".repeat(129))).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.status("order with spaces")).rejects.toThrow(SatimInvalidArgumentError);
    });
});

describe("Satim - response data redaction (I5)", () => {
    test("getRawResponse redacts sensitive cardholder data", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        const mockRequest = vi.fn(async () => ({
            OrderStatus: "2",
            Amount: "5000",
            Ip: "192.168.1.100",
            Pan: "4111**1111",
            cardholderName: "John Doe",
            expiration: "202812",
            approvalCode: "ABC123",
        }));
        (satim as any).httpClientService = { handleApiRequest: mockRequest };

        const response = await satim.confirm("mock123", 50);
        const raw = response.getRawResponse();

        expect(raw.Ip).toBe("[REDACTED]");
        expect(raw.Pan).toBe("[REDACTED]");
        expect(raw.cardholderName).toBe("[REDACTED]");
        expect(raw.expiration).toBe("[REDACTED]");
        // Non-sensitive fields should be preserved
        expect(raw.OrderStatus).toBe("2");
        expect(raw.approvalCode).toBe("ABC123");
    });
});

describe("Satim - toMinorUnits precision (L1)", () => {
    test("IEEE 754 edge cases are handled correctly", async () => {
        const { toMinorUnits } = await import("../src/utils");
        expect(toMinorUnits(19.99)).toBe(1999);
        expect(toMinorUnits(500)).toBe(50000);
        expect(toMinorUnits(0.1)).toBe(10);
        expect(toMinorUnits(0.01)).toBe(1);
    });

    test("rejects sub-centime precision amounts", async () => {
        const { toMinorUnits } = await import("../src/utils");
        expect(() => toMinorUnits(1.005)).toThrow("more than 2 decimal places");
        expect(() => toMinorUnits(19.999)).toThrow("more than 2 decimal places");
    });

    test("rejects invalid amounts", async () => {
        const { toMinorUnits } = await import("../src/utils");
        expect(() => toMinorUnits(0)).toThrow("finite positive");
        expect(() => toMinorUnits(-10)).toThrow("finite positive");
        expect(() => toMinorUnits(Infinity)).toThrow("finite positive");
        expect(() => toMinorUnits(NaN)).toThrow("finite positive");
    });

    test("rejects amounts exceeding MAX_SAFE_AMOUNT", async () => {
        const { toMinorUnits } = await import("../src/utils");
        expect(() => toMinorUnits(10_000_000_000)).toThrow("MAX_SAFE_AMOUNT");
    });
});

describe("Satim - SatimGatewayError export (L2)", () => {
    test("SatimGatewayError is exported and constructable", () => {
        const err = new SatimGatewayError("1", "Duplicate order");
        expect(err).toBeInstanceOf(Error);
        expect(err.errorCode).toBe("1");
        expect(err.errorMessage).toBe("Duplicate order");
        expect(err.message).toContain("code 1");
    });
});

describe("Satim - IPv4-compatible IPv6 SSRF bypass", () => {
    const make = () => new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects IPv4-compatible loopback ::7f00:1", () => {
        expect(() => make().returnUrl("http://[::7f00:1]/cb")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects IPv4-compatible private 10.x ::a00:1", () => {
        expect(() => make().returnUrl("http://[::a00:1]/cb")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects IPv4-compatible 192.168.x ::c0a8:1", () => {
        expect(() => make().returnUrl("http://[::c0a8:1]/cb")).toThrow(SatimInvalidArgumentError);
    });

    test("rejects IPv4-compatible metadata ::a9fe:a9fe", () => {
        expect(() => make().returnUrl("http://[::a9fe:a9fe]/cb")).toThrow(SatimInvalidArgumentError);
    });
});

describe("Satim - credential whitespace/length validation", () => {
    test("rejects whitespace-only credentials", () => {
        expect(() => new Satim({ username: "  ", password: "p", terminalId: "t" })).toThrow();
        expect(() => new Satim({ username: "u", password: "\t", terminalId: "t" })).toThrow();
    });

    test("rejects oversized credentials", () => {
        expect(() => new Satim({ username: "a".repeat(257), password: "p", terminalId: "t" })).toThrow(SatimInvalidArgumentError);
    });

    test("trims credentials", async () => {
        const satim = new Satim({ username: " u ", password: " p ", terminalId: " t " });
        const mockRequest = vi.fn(async (_e: string, data: any) => ({
            errorCode: "0", orderId: "o1", formUrl: "https://test.satim.dz/f",
        }));
        (satim as any).httpClientService = { handleApiRequest: mockRequest };
        await satim.amount(100).returnUrl("https://example.com/r").register();
        const [, sentData] = mockRequest.mock.calls[0];
        expect(sentData.userName).toBe("u");
        expect(sentData.password).toBe("p");
    });
});

describe("Satim - description HTML sanitization", () => {
    const make = () => new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects HTML tags in description", () => {
        expect(() => make().description("<script>alert(1)</script>")).toThrow(SatimInvalidArgumentError);
        expect(() => make().description('Buy <img src=x onerror=alert(1)>')).toThrow(SatimInvalidArgumentError);
    });

    test("allows plain text descriptions", () => {
        expect(() => make().description("Payment for order #123")).not.toThrow();
    });
});

describe("Satim - amount overflow guard", () => {
    const make = () => new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects amounts exceeding safe precision for toPrecision(12)", () => {
        expect(() => make().amount(Number.MAX_SAFE_INTEGER)).toThrow(SatimInvalidArgumentError);
        expect(() => make().amount(10_000_000_000)).toThrow(SatimInvalidArgumentError);
        expect(() => make().amount(9_999_999_999.999)).toThrow(SatimInvalidArgumentError);
    });

    test("allows amounts at the safe boundary", () => {
        expect(() => make().amount(9_999_999_999)).not.toThrow();
        expect(() => make().amount(1_000_000_000)).not.toThrow();
    });
});

describe("Satim - sub-centime amount guard", () => {
    const make = () => new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects amounts that round to 0 minor units", () => {
        expect(() => make().amount(0.001)).toThrow(SatimInvalidArgumentError);
        expect(() => make().amount(0.004)).toThrow(SatimInvalidArgumentError);
    });

    test("rejects amounts below 50 DA minimum", () => {
        expect(() => make().amount(0.01)).toThrow(SatimInvalidArgumentError);
        expect(() => make().amount(49)).toThrow(SatimInvalidArgumentError);
        expect(() => make().amount(50)).not.toThrow();
    });
});

describe("Satim - reserved userDefinedField keys", () => {
    const make = () => new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects __proto__, constructor, prototype keys", () => {
        expect(() => make().userDefinedField("__proto__", "val")).toThrow(SatimInvalidArgumentError);
        expect(() => make().userDefinedField("constructor", "val")).toThrow(SatimInvalidArgumentError);
        expect(() => make().userDefinedField("prototype", "val")).toThrow(SatimInvalidArgumentError);
    });
});

describe("Satim - toString/toPrimitive redaction", () => {
    test("toString does not leak credentials", () => {
        const satim = new Satim({ username: "secret_user", password: "secret_pass", terminalId: "secret_tid" });
        const str = satim.toString();
        expect(str).not.toContain("secret_user");
        expect(str).toContain("REDACTED");
    });

    test("string coercion does not leak credentials", () => {
        const satim = new Satim({ username: "secret_user", password: "secret_pass", terminalId: "secret_tid" });
        const str = `${satim}`;
        expect(str).not.toContain("secret_user");
        expect(str).toContain("REDACTED");
    });
});

describe("Satim - confirm requires expectedAmount", () => {
    test("rejects invalid expectedAmount", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        await expect(satim.confirm("mock123", 0)).rejects.toThrow(SatimInvalidArgumentError);
        await expect(satim.confirm("mock123", -10)).rejects.toThrow(SatimInvalidArgumentError);
    });
});

describe("Satim - status predicate mutual exclusivity", () => {
    test("successful payment with rejection actionCode is not rejected", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "2", actionCode: "2003" } as any);
        expect(response.isSuccessful()).toBe(true);
        expect(response.isRejected()).toBe(false);
        expect(response.isCancelled()).toBe(false);
        expect(response.isExpired()).toBe(false);
    });

    test("successful payment with cancel actionCode is not cancelled", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "2", actionCode: "10" } as any);
        expect(response.isSuccessful()).toBe(true);
        expect(response.isCancelled()).toBe(false);
    });

    test("successful payment with expired actionCode is not expired", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "2", actionCode: "-2007" } as any);
        expect(response.isSuccessful()).toBe(true);
        expect(response.isExpired()).toBe(false);
    });

    test("cancelled is not rejected", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "6", actionCode: "10" } as any);
        expect(response.isCancelled()).toBe(true);
        expect(response.isRejected()).toBe(false);
    });

    test("pending with cancel actionCode stays pending, not cancelled", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "0", actionCode: "10" } as any);
        expect(response.isPending()).toBe(true);
        expect(response.isCancelled()).toBe(false);
    });
});

describe("Satim - isPending and isReversed predicates", () => {
    test("isPending for OrderStatus 0", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "0" } as any);
        expect(response.isPending()).toBe(true);
        expect(response.isFailed()).toBe(false);
        expect(response.isSuccessful()).toBe(false);
    });

    test("isReversed for OrderStatus 3", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "3" } as any);
        expect(response.isReversed()).toBe(true);
        expect(response.isFailed()).toBe(false);
    });
});

describe("Satim - respCode undefined is not treated as rejection", () => {
    test("params without respCode does not trigger rejection", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({
            OrderStatus: "2",
            ErrorCode: "0",
            params: { respCode_desc: "Approved" },
        } as any);
        expect(response.isSuccessful()).toBe(true);
        expect(response.isRejected()).toBe(false);
    });
});

describe("Satim - case-insensitive ErrorMessage matching", () => {
    test("lowercase declined message is detected", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({
            OrderStatus: "6",
            ErrorCode: "2",
            ErrorMessage: "payment is declined",
        } as any);
        expect(response.isRejected()).toBe(true);
    });

    test("lowercase cancelled message is detected", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({
            OrderStatus: "6",
            ErrorCode: "2",
            ErrorMessage: "PAYMENT IS CANCELLED",
        } as any);
        expect(response.isCancelled()).toBe(true);
    });
});

describe("Satim - getErrorMessage specificity", () => {
    test("expired payment returns specific message", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "6", actionCode: "-2007" } as any);
        expect(response.getErrorMessage()).toBe("Payment session expired");
    });

    test("cancelled payment returns specific message", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "6", actionCode: "10" } as any);
        expect(response.getErrorMessage()).toBe("Payment was cancelled");
    });
});

describe("Satim - register accepts missing errorCode", () => {
    test("register succeeds when gateway omits errorCode field", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        const mockRequest = vi.fn(async () => ({
            orderId: "abc123",
            formUrl: "https://test.satim.dz/payment/form",
        }));
        (satim as any).httpClientService = { handleApiRequest: mockRequest };
        const response = await satim.amount(100).returnUrl("https://example.com/r").register();
        expect(response.getOrderId()).toBe("abc123");
    });
});

describe("Satim - verifyAmount rejects non-positive gateway amounts", () => {
    test("verifyAmount rejects zero gateway amount", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "2", Amount: "0" } as any);
        expect(() => response.verifyAmount(50)).toThrow(SatimUnexpectedResponseError);
    });

    test("verifyAmount rejects negative gateway amount", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "2", Amount: "-5000" } as any);
        expect(() => response.verifyAmount(50)).toThrow(SatimUnexpectedResponseError);
    });
});

describe("Satim - reversed orders are not rejected or failed", () => {
    test("reversed order is not rejected", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "3" } as any);
        expect(response.isReversed()).toBe(true);
        expect(response.isRejected()).toBe(false);
        expect(response.isFailed()).toBe(false);
        expect(response.isCancelled()).toBe(false);
        expect(response.isExpired()).toBe(false);
    });

    test("reversed order shows voided message", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "3" } as any);
        expect(response.getErrorMessage()).toBe("Payment authorization was voided");
    });
});

describe("Satim - mutual exclusivity of predicates", () => {
    test("expired + OrderStatus 3 is reversed, not expired or rejected", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "3", actionCode: "-2007" } as any);
        expect(response.isReversed()).toBe(true);
        expect(response.isExpired()).toBe(false);
        expect(response.isRejected()).toBe(false);
    });

    test("expired + cancelled ErrorMessage: expired wins (not cancelled)", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "6", actionCode: "-2007", ErrorMessage: "Payment is cancelled" } as any);
        expect(response.isExpired()).toBe(true);
        expect(response.isCancelled()).toBe(false);
    });

    test("expired is not rejected", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "6", actionCode: "-2007", params: { respCode: "05" } } as any);
        expect(response.isExpired()).toBe(true);
        expect(response.isRejected()).toBe(false);
    });
});

describe("Satim - empty respCode is not treated as rejection", () => {
    test("empty string respCode does not trigger rejection", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({
            OrderStatus: "6",
            params: { respCode: "" },
        } as any);
        expect(response.isRejected()).toBe(false);
    });
});

describe("Satim - undefined ErrorCode guard", () => {
    test("missing ErrorCode with no params/actionCode is not rejected", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "6" } as any);
        expect(response.isRejected()).toBe(false);
        expect(response.isCancelled()).toBe(false);
    });
});

describe("Satim - getSuccessMessage for pending orders", () => {
    test("pending order returns pending message", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "0" } as any);
        expect(response.getSuccessMessage()).toBe("Payment is pending");
    });
});

describe("Satim - confirm rejects expectedAmount > MAX_SAFE_AMOUNT", () => {
    test("rejects huge expectedAmount", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        await expect(satim.confirm("mock123", 10_000_000_000)).rejects.toThrow(SatimInvalidArgumentError);
    });
});

describe("Satim - sub-centime precision rejection", () => {
    const make = () => new Satim({ username: "u", password: "p", terminalId: "t" });

    test("rejects amounts with 3+ decimal places", () => {
        expect(() => make().amount(19.999)).toThrow(SatimInvalidArgumentError);
        expect(() => make().amount(1.005)).toThrow(SatimInvalidArgumentError);
        expect(() => make().amount(100.123)).toThrow(SatimInvalidArgumentError);
    });

    test("allows whole-dinar amounts above 50 DA minimum", () => {
        expect(() => make().amount(51)).not.toThrow();
        expect(() => make().amount(100)).not.toThrow();
    });

    test("confirm rejects expectedAmount with 3+ decimal places", async () => {
        const satim = make();
        await expect(satim.confirm("mock123", 19.999)).rejects.toThrow(SatimInvalidArgumentError);
    });

    test("refund rejects amount with 3+ decimal places", async () => {
        const satim = make();
        await expect(satim.refund("mock123", 19.999)).rejects.toThrow(SatimInvalidArgumentError);
    });
});

describe("Satim - getAmount precision", () => {
    test("getAmount returns precise 2-decimal values", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "2", Amount: "3" } as any);
        expect(response.getAmount()).toBe(0.03);

        const response2 = new ConfirmResponse({ OrderStatus: "2", Amount: "7" } as any);
        expect(response2.getAmount()).toBe(0.07);

        const response3 = new ConfirmResponse({ OrderStatus: "2", Amount: "33" } as any);
        expect(response3.getAmount()).toBe(0.33);
    });
});

describe("Satim - verifyAmount strict decimal parsing", () => {
    test("rejects hex-encoded gateway amounts", async () => {
        const { ConfirmResponse } = await import("../src/responses");
        const response = new ConfirmResponse({ OrderStatus: "2", Amount: "0x7CF" } as any);
        expect(() => response.verifyAmount(19.99)).toThrow(SatimUnexpectedResponseError);
    });
});

describe("Satim - refund does not verify response amount", () => {
    test("refund returns response without amount verification (SATIM refund.do does not return Amount)", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        const mockRequest = vi.fn(async () => ({
            errorCode: "0",
        }));
        (satim as any).httpClientService = { handleApiRequest: mockRequest };
        const response = await satim.refund("mock123", 50);
        expect(response).toBeDefined();
    });

    test("refund with OrderStatus 4 returns refunded response", async () => {
        const satim = new Satim({ username: "u", password: "p", terminalId: "t" });
        const mockRequest = vi.fn(async () => ({
            OrderStatus: "4",
            Amount: "5000",
        }));
        (satim as any).httpClientService = { handleApiRequest: mockRequest };
        const response = await satim.refund("mock123", 50);
        expect(response.isRefunded()).toBe(true);
    });
});

describe("Satim - hasSubCentimePrecision utility", () => {
    test("detects sub-centime precision correctly", async () => {
        const { hasSubCentimePrecision } = await import("../src/utils");
        expect(hasSubCentimePrecision(1.005)).toBe(true);
        expect(hasSubCentimePrecision(19.999)).toBe(true);
        expect(hasSubCentimePrecision(0.001)).toBe(true);
        expect(hasSubCentimePrecision(19.99)).toBe(false);
        expect(hasSubCentimePrecision(100)).toBe(false);
        expect(hasSubCentimePrecision(0.01)).toBe(false);
        expect(hasSubCentimePrecision(0.1)).toBe(false);
    });
});

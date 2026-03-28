# Refunds

A refund returns money from your merchant account back to the customer's CIB card. This page covers how to issue refunds using the SDK, what validation is applied, how the SDK protects against partial-refund manipulation, and what errors you might encounter.

---

## When to use refunds

Use `refund()` when a payment has already been **captured** (deposited) and you need to return some or all of the money. Common scenarios include:

- The customer requests a return or cancellation after payment.
- You shipped the wrong item or the item was defective.
- A duplicate charge occurred and you need to reverse one.
- Your business logic requires a partial refund (e.g., returning one item from a multi-item order).

> **Refund vs. reversal:** If the payment has **not yet been settled** by the acquirer (typically within the same business day), use `reverseOrder()` instead. Reversals void the authorization before batch settlement and avoid processing fees. See [Advanced Features](06-advanced-features.md).

---

## Basic example

```typescript
// Refund the full amount of 1000 DZD
const response = await satim.refund(orderId, 1000);

if (response.isRefunded()) {
    console.log("Refund processed successfully.");
    console.log(`Refunded amount: ${response.getAmount()} DZD`);
}

if (response.isFailed()) {
    console.error(`Refund failed: ${response.getErrorMessage()}`);
}
```

### Partial refund

You can refund less than the original payment amount. SATIM allows multiple partial refunds on a single order as long as the cumulative total does not exceed the original deposited amount.

```typescript
// Original payment was 5000 DZD — refund 2000 DZD
const response = await satim.refund(orderId, 2000);

if (response.isRefunded()) {
    console.log("Partial refund of 2000 DZD processed.");
}
```

---

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `orderId` | `string` | Yes | The order identifier returned by `register()` when the original payment was created. Must be a string (not a number or array), alphanumeric + hyphens, 1–128 characters. |
| `amount` | `number` | Yes | The refund amount in **major currency units** (e.g., dinars, not centimes). The SDK converts to minor units (centimes) automatically. |

### Amount validation

The `amount` parameter goes through the same validation pipeline as `amount()` in the registration flow:

| Rule | Error message |
|---|---|
| Must be a JavaScript `number` type (not array, string, boolean, null, object) | `"Amount must be a number, got <type>."` |
| Must be positive and finite | `"Amount must be a finite positive number"` |
| Must not exceed 9,999,999,999.99 | `"Amount exceeds safe precision for minor-unit conversion."` |
| Must not have more than 2 decimal places | `"Amount must not have more than 2 decimal places."` |
| Must convert to at least 1 centime | `"Amount too small: must convert to at least 1 minor unit (centime/cent)."` |

The currency is automatically included in the refund request from the payment client's configured currency (default: DZD / `"012"`).

---

## Refund response

The SATIM `/refund.do` endpoint returns only `errorCode` and `errorMessage` — it does **not** return `Amount`, `OrderStatus`, or other order-level fields. This means the SDK cannot perform automatic amount verification on refund responses the way it does for payment confirmations.

If the refund request succeeds (`errorCode: 0`), the gateway has accepted it. If you need to verify the order's updated state after a refund (e.g., to confirm `OrderStatus` changed to `"4"` / refunded), call `status(orderId)` separately.

---

## Return value

`refund()` returns a `ConfirmResponse` object — the same type returned by `confirm()` and `status()`. You can use all the same status predicates and data accessors described in [Verifying a Payment](04-verifying-payment.md).

The most relevant predicates for refund responses:

| Predicate | Meaning for refunds |
|---|---|
| `isRefunded()` | The refund was processed successfully. OrderStatus is `"4"`. |
| `isSuccessful()` | Some gateways return OrderStatus `"2"` for a successful refund. The SDK checks both. |
| `isFailed()` | The refund failed. Call `getErrorMessage()` for details. |
| `isRejected()` | The bank explicitly declined the refund. |

---

## Error codes

SATIM's `/refund.do` endpoint returns specific error codes for refund failures:

| ErrorCode | Description | What to do |
|---|---|---|
| `"0"` | No error — refund was processed successfully. | Nothing — the refund succeeded. |
| `"5"` | Access denied. Can also mean the `orderId` was empty or the account requires a password change. | Verify your credentials. Ensure the `orderId` is not empty. Contact CIBWeb if the error persists. |
| `"6"` | Invalid or unknown order number. The `orderId` does not match any registered order. | Double-check the `orderId`. Make sure you are using the ID returned by `register()`, not your internal order reference. |
| `"7"` | Invalid payment state or deposit amount. The order may not have been deposited yet, or the refund amount exceeds the deposited amount. | Verify the order was successfully deposited (OrderStatus 2) before refunding. Ensure the refund amount does not exceed the original payment. |

These error codes are mapped to specific SDK error classes:

| ErrorCode | SDK error class |
|---|---|
| `"5"` | `SatimInvalidCredentialsError` |
| `"6"` | `SatimInvalidArgumentError` |
| `"7"` | `SatimGatewayError` with `errorCode: "7"` |

---

## Retry behavior

Refund requests are **not retried** by default. This is a deliberate safety measure — retrying a refund could cause a double refund if the original request succeeded but the response was lost in transit.

If you need to handle transient failures (timeouts, 5xx responses) when issuing refunds, implement retry logic at the application level with your own idempotency mechanism:

```typescript
async function issueRefund(orderId: string, amount: number): Promise<ConfirmResponse> {
    // Check if we already issued this refund
    const existingRefund = await db.refunds.findByOrderId(orderId);
    if (existingRefund?.status === "processed") {
        // Already refunded — fetch the latest status instead of refunding again
        return satim.status(orderId);
    }

    // Record the refund attempt before calling the gateway
    await db.refunds.create({ orderId, amount, status: "pending" });

    const response = await satim.refund(orderId, amount);

    if (response.isRefunded()) {
        await db.refunds.update({ orderId, status: "processed" });
    } else {
        await db.refunds.update({ orderId, status: "failed" });
    }

    return response;
}
```

---

## Important notes

1. **Not all merchant accounts have refund enabled.** The `/refund.do` endpoint must be explicitly enabled for your terminal by CIBWeb. If you receive `SatimInvalidCredentialsError` or unexpected permission errors, contact your CIBWeb account manager.

2. **Refunds are asynchronous on the banking side.** Even after `isRefunded()` returns `true`, the actual credit to the customer's account may take 1–5 business days depending on the issuing bank.

3. **You must store the orderId.** The refund endpoint requires the original `orderId` from `register()`. If you lose this identifier, you cannot issue a refund through the API. Always persist orderId in your database alongside your internal order reference.

4. **The original payment must be deposited.** You cannot refund a payment that is still pending, has been reversed, or was never captured. Check the order status with `status()` before attempting a refund if you are unsure of the current state.

---

## Next step

For pre-authorization holds, order reversals, webhook configuration, and other advanced patterns, see [Advanced Features](06-advanced-features.md).

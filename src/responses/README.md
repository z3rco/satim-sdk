# responses

Typed wrappers around SATIM gateway response payloads.

## Responsibility

Validate raw gateway JSON at the SDK boundary, then expose typed accessors and mutually
exclusive status predicates. PII (`Ip`, `Pan`, `cardholderName`, `expiration`) is redacted
in any raw copy handed back to callers.

## Files

| File | Responsibility |
| - | - |
| [`schema.ts`](./schema.ts) | `validateRegisterSchema`, `validateConfirmSchema`. Rejects non objects, requires non empty `orderId` and `formUrl` on registration, and coerces `OrderStatus`, `ErrorCode`, `actionCode` from number to string because SATIM serialises them inconsistently across endpoints |
| [`register.ts`](./register.ts) | `RegisterResponse`. Wraps `/register.do` and `/registerPreAuth.do`. `getOrderId`, `getUrl`, `redirectResponse`, `getRawResponse` |
| [`confirm.ts`](./confirm.ts) | `ConfirmResponse`. Wraps `/public/acknowledgeTransaction.do`, `/getOrderStatus.do`, `/getOrderStatusExtended.do`, `/deposit.do`, `/refund.do`, `/reverse.do`, `/decline.do`. Accessors, predicates, amount verification, PII redacted raw access |

## Internal dependencies

| Import | Used for |
| - | - |
| `../exceptions` | `SatimUnexpectedResponseError`, `SatimMissingDataError`, `SatimInvalidArgumentError` |
| `../types` | `RegisterOrderResponse`, `ConfirmOrderResponse` |
| `../money` | `toMinorUnits`, `isWholeMinorUnits` |

Both constructors `structuredClone` the payload, detaching it from any reference held by
the HTTP client.

## Status predicate contract

Exactly one predicate returns `true` for any well formed response. The dependency chain is
acyclic:

```
leaves:      isPending, isPreAuthorized, isSuccessful, isReversed,
             isRefunded, isPartiallyCaptured, isRejected (OrderStatus 6 branch)
isExpired    -> leaves
isCancelled  -> leaves, isExpired
isRejected   -> leaves, isExpired, isCancelled   (composite branch)
isFailed     -> everything above
```

Known status set: `0`, `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`. Composite predicates return
`false` whenever a known status is present, so the composite branches only run on
responses that carry no `OrderStatus` at all (declines, cancels, expiries).

Error signal: `ErrorCode` present and not `"0"`, or `params` present, or `actionCode`
present. `isCancelled` and `isRejected` both require it.

Message matching ("payment is cancelled", "payment is declined") is an English only
fallback and the SDK defaults to `language=FR`, so `actionCode` is authoritative and the
string test runs last. Full table in [ARCHITECTURE.md](../../ARCHITECTURE.md) section 8.

Adding a predicate requires extending the known status set and the exclusion list of every
predicate later in the chain.

## Amount handling

`getAmount()` and `getDepositAmount()`:

1. Accept `"5000"` or `"5000.00"`; anything else returns `undefined`.
2. Reject non integer, non positive, or above `Number.MAX_SAFE_INTEGER` with `undefined`.
3. Return `parseFloat((minor / 100).toFixed(2))`.

`verifyAmount(expected)`:

1. Reads `Amount`, falling back to `amount`. Missing throws `SatimUnexpectedResponseError`.
2. Rejects anything not matching integral minor units, including genuinely fractional values.
3. Converts `expected` through `toMinorUnits`, the same guarded path used at registration.
4. Compares minor unit integers. A mismatch throws with both values in the message.

`Satim.confirm()` calls it automatically on `isSuccessful()` responses; the caller cannot
skip it. `status()` and `statusExtended()` do not: call it yourself before fulfilling.

## PII redaction

`ConfirmResponse.getRawResponse()` returns a shallow copy with `Ip`, `Pan`,
`cardholderName` and `expiration` replaced by `"[REDACTED]"`. Nested objects such as
`params` are shared by reference; treat the copy as read only.

Typed accessors (`getIpAddress`, `getCardPan`, `getCardHolderName`, `getCardExpiry`)
return unredacted values. Callers must ask for them explicitly.

`RegisterResponse.getRawResponse()` is a shallow copy with no redaction: the registration
payload carries no PII.

## Form URL allowlist

`getUrl()` and `redirectResponse()` both call `assertTrustedFormUrl`: HTTPS only, hostname
in `{satim.dz, cib.satim.dz, test.satim.dz, test2.satim.dz}`. This is the only barrier
against a tampered `formUrl` sending customers to an attacker domain, so it must stay on
every path that hands the URL out.

## Blast radius

| Editing | Affects |
| - | - |
| `schema.ts` | all response construction. Loosening lets malformed payloads propagate; tightening may reject future spec revisions |
| `register.ts` allowlist | open redirect exposure for every merchant redirect |
| `confirm.ts` predicates | the exclusivity contract. Coverage in `tests/app.test.ts` and `tests/adversarial.test.ts` exercises `OrderStatus`, `actionCode`, `respCode` and `ErrorMessage` combinations |
| `confirm.ts` `verifyAmount` | the only amount fraud check. It must stay on the `isSuccessful()` path in `Satim.confirm` |

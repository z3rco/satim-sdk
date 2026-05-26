# responses

Typed wrappers around SATIM gateway response payloads.

## Responsibility

Validate raw gateway JSON at the SDK boundary, then expose typed accessors and status predicates for application use. PII fields (`Ip`, `Pan`, `cardholderName`, `expiration`) are redacted in any raw-response copy exposed to callers.

## Files

| File | Responsibility |
|------|----------------|
| [`schema.ts`](./schema.ts) | Runtime schema validators (`validateRegisterSchema`, `validateConfirmSchema`). Normalises number→string coercions for fields the SATIM spec serialises inconsistently (`OrderStatus`, `ErrorCode`, `actionCode`). |
| [`register.ts`](./register.ts) | `RegisterResponse`. Wraps `/register.do` and `/registerPreAuth.do` results. Provides `getOrderId`, `getUrl`, and `redirectResponse` (which enforces HTTPS and a trusted `*.satim.dz` hostname). |
| [`confirm.ts`](./confirm.ts) | `ConfirmResponse`. Wraps `/confirmOrder`, `/getOrderStatus`, `/refund`, `/reverse` results. Provides typed accessors, the mutually-exclusive status predicates, amount verification, and PII-redacted raw response access. |

## Dependencies

| External (within `src/`) | Used for |
|--------------------------|----------|
| `../exceptions` | `SatimUnexpectedResponseError`, `SatimMissingDataError`, `SatimInvalidArgumentError`. |
| `../types` | `RegisterOrderResponse`, `ConfirmOrderResponse`. |
| `../money` | `toMinorUnits`, `isWholeMinorUnits` for amount verification and reverse conversion. |

`structuredClone` (Web API) is used in both response constructors to detach the gateway payload from any external reference held by the HTTP client.

## Status predicate contract

Defined and enforced in `confirm.ts`. For any well-formed response, **exactly one** terminal predicate returns `true`. The dependency chain is acyclic:

```
isSuccessful, isPending, isReversed, isRefunded, isPreAuthorized   (leaves)
isExpired      → leaves
isCancelled    → leaves, isExpired
isRejected     → leaves, isExpired, isCancelled
isFailed       → leaves, isExpired, isCancelled, isRejected
```

Adding a tenth predicate requires updating the exclusion list of every predicate that comes after it in the chain. See the comment block at the top of [`confirm.ts`](./confirm.ts) for the canonical statement.

## Amount verification

`ConfirmResponse.verifyAmount(expectedAmount)`:

- Reads `Amount` (or `amount`) from the gateway response.
- Rejects non-integer or non-positive values with `SatimUnexpectedResponseError`.
- Converts `expectedAmount` to minor units via `toMinorUnits` (the same IEEE-754-safe pipeline used at registration).
- Compares minor-unit integers. Mismatch throws `SatimUnexpectedResponseError` with the expected and actual values.

`Satim.confirm()` calls this automatically on `isSuccessful()` responses — there is no way for a caller to skip it.

## PII redaction

`getRawResponse()` on `ConfirmResponse` returns a shallow copy with the following fields replaced by `"[REDACTED]"`:

- `Ip` (cardholder IP)
- `Pan` (masked PAN string)
- `cardholderName`
- `expiration`

Typed accessors (`getCardPan`, `getCardHolderName`, `getCardExpiry`, `getIpAddress`) return the unredacted values — callers that need them must request them explicitly.

## Impact of changes

| Editing | Potentially affects |
|---------|---------------------|
| `schema.ts` | All response construction. Loosening validation lets malformed gateway responses propagate; tightening it may reject responses from future spec revisions. |
| `register.ts` `redirectResponse` | The trusted-hostname allowlist is the only barrier against the gateway redirecting customers to attacker-controlled domains via a tampered `formUrl`. |
| `confirm.ts` predicate logic | The mutual-exclusivity contract. Test coverage in `tests/app.test.ts` and `tests/adversarial.test.ts` exercises every combination of `OrderStatus`, `actionCode`, `respCode`, and `ErrorMessage`. |
| `confirm.ts` `verifyAmount` | The only amount-fraud check against partial-capture manipulation. Must not be moved out of the `isSuccessful()` path in `Satim.confirm`. |

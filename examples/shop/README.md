# Demo shop

A working storefront built on the SDK, paying against the local
[mock gateway](../../mock/README.md). No credentials, no network, no
paperwork — click through a real checkout and watch every SDK call and
gateway response scroll past in the console.

```bash
npm run build
npm run shop
```

Then open **<http://localhost:8788>**.

Add a few items, hit *Payer par carte*, and you are redirected to the
gateway's hosted payment page. Pick a test card there and the flow comes
back to the shop.

## What you are looking at

```
browser            demo shop (this)              mock gateway
   │                     │                            │
   │── add to cart ─────▶│                            │
   │── POST /checkout ──▶│── satim.safeRegister() ───▶│
   │                     │◀── orderId + formUrl ──────│
   │◀── redirect ────────│                            │
   │──────────── hosted payment page ────────────────▶│
   │                     │◀═ POST /callback ══════════│  server-to-server
   │                     │── satim.confirm() ────────▶│  re-fetch live state
   │                     │   order marked PAID        │
   │◀─────────── redirect to /return ─────────────────│
```

The callback and the browser redirect race each other, exactly as they do
in production. The shop fulfils on the **callback** — that one arrives even
if the customer closes the tab — and `/return` only decides what to render.
Watch the log: on a fast machine the webhook usually wins, and `/return`
then reads state with `status()` instead of acknowledging twice.

## Test cards

Chosen on the gateway's payment page:

| PAN | Result in the shop |
|-----|--------------------|
| `6280581000000000` | `PAID`, with approval code and masked card |
| `6280581000000001` | `FAILED` — refused (provision insuffisante) |
| `6280581000000002` | `FAILED` — 3-D Secure failed |
| `6280581000000003` | `FAILED` — session expired |
| `6280581000000004` | `FAILED` — cancelled by cardholder |
| `6280581000000005` | Pre-authorized hold |

Paid orders get a *Rembourser* button, which calls `satim.refund()`.

## The parts worth copying

`server.mjs` is ~300 lines and is a realistic integration, not a toy:

- **Registration** — `safeRegister(ref)` derives an idempotency key from the
  shop's own order reference, so a double-click cannot create two orders.
- **The amount comes from the shop's records**, never from the request.
  `onResolveAmount` looks it up by gateway order id; that is what makes the
  SDK's amount verification meaningful.
- **`inspect()` rather than `verify()`** in the callback, so a rate-limited
  notification answers `429` and gets redelivered instead of being silently
  dropped by a `200`.
- **Fulfilment is guarded by `duplicate`**, so a replayed callback never
  ships an order twice.
- **`/return` is treated as untrusted** — anyone can call it with any
  orderId. It renders; it does not decide.

## Local callback URLs

The SDK refuses loopback and private addresses in `returnUrl`, `failUrl`
and `dynamicCallbackUrl`: those URLs are handed to the gateway, and
pointing them at internal addresses is how SSRF happens. Local development
obviously needs them, so there is an explicit opt-in:

```ts
satim.allowPrivateUrls(true).returnUrl("http://localhost:8788/return")
```

Call it **before** the URL setters — each URL is validated as it is set.
Never set it in production. Obfuscated IP encodings stay rejected either
way, and the opt-in is per instance: it cannot leak into another client
through the shared validation cache.

For callbacks from the *real* gateway you need a publicly reachable URL,
so an ngrok-style tunnel is what you would use during certification.

## What this does not prove

The gateway is a mock. It cannot validate real 3-D Secure, issuer
decisioning, settlement, or the gateway's true response shapes beyond what
the SDK already assumes. See the limitations section in
[`mock/README.md`](../../mock/README.md) — a green run here means the
integration is internally consistent, not that it is certified.

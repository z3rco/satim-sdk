# mock

A local stand-in for the SATIM gateway, so the SDK can be exercised end to
end without merchant credentials and without a network.

Getting real credentials means a registered business, a bank convention,
GIE Monétique approval and SATIM certification — weeks of paperwork before
a single line of integration code can be run. This closes most of that gap:
everything except real 3-D Secure, real bank decisioning and real
settlement.

## Run it

```bash
npm run build          # the demo consumes dist/, like a real merchant
node mock/gateway.mjs  # terminal 1 — gateway on :8787
node mock/demo.mjs     # terminal 2 — the full walkthrough
```

Or open <http://localhost:8787/payment/merchants/mockshop/payment_fr.html?mdOrder=…>
in a browser after registering an order, and click through the hosted form
yourself.

## Point the SDK at it

```ts
const satim = new Satim(
    { username: "test_merchant", password: "test_password", terminalId: "E005005099" },
    new HttpClientService(false, { baseUrl: "http://localhost:8787/payment/rest" }),
);
```

`baseUrl` accepts plaintext `http:` only for loopback and private hosts —
every request body carries the merchant password, so a plaintext URL to a
public host is refused.

## The payment page

The hosted page is a real form: card number, expiry, CVV and cardholder
name, validated server-side (Luhn, BIN, expiry in the future, CVV length)
before any issuer is contacted. A card that passes goes to a 3-D Secure
challenge, and only then does the issuer decide.

That matters. A page that just lets you pick an outcome never produces the
states integrations trip over: a **second attempt on an order that already
failed**, an order left **pending** because the issuer never answered, a
**session that expired** mid-checkout. Those are reachable here.

## Test cards

| PAN | 3-D Secure | Issuer |
|-----|-----------|--------|
| `6280581000000007` | challenge | approves |
| `6280581000000015` | challenge | declines — insufficient funds (`116`) |
| `6280581000000023` | challenge always fails | — |
| `6280581000000031` | challenge | declines — do not honour (`05`) |
| `6280581000000049` | challenge | declines — restricted card (`62`) |
| `6280581000000056` | challenge | approves as a **pre-authorization** (hold) |
| `6280581000000064` | challenge | never answers — order stays **pending** (`91`) |
| `6280581000000072` | challenge | **checks a real 10 000,00 DA balance** — debits it, declines when short |
| `5078001000000004` | frictionless, no challenge | approves (Edahabia) |

Any future expiry, any 3-4 digit CVV, any cardholder name. The 3-D Secure
OTP is `123456`; anything else is refused, three attempts per card.

Every PAN is Luhn-valid, so the form accepts it exactly as it would accept
a real card — what differs is what the *issuer* then does.

## The funded card

`6280581000000072` carries an actual account balance of 10 000,00 DA. The
issuer checks it against the order amount, debits it on approval, and
declines with *provision insuffisante* when the account is short. Refunds
and reversals credit it back.

So a decline from this card is **earned rather than scripted**: buy 4 800 DA
of olive oil and 4 500 DA of honey and the third purchase fails because
850 DA is more than the 700 DA left, not because a fixture said so. Draining
an account across several orders is a state no scripted card can reach.

`GET /__balances` shows what is left; `POST /__reset` restores it. The
payment page lists the live balance beside the card.

## Reaching the other states

- **Cancel** — the *Annuler le paiement* button on the form.
- **Expiry** — `POST /__expire?orderId=…` ages the session out, then pay.
- **Retry after a decline** — the declined page offers a retry link back to
  the same order. Use a different card and it settles normally. This is the
  path that produced the webhook bug where a paid customer went unfulfilled.

## Fault injection

`POST /__control` arms transport faults, consumed one response at a time.
They exist to reach the paths a healthy gateway never produces — which is
where the circuit-breaker accounting bugs were hiding.

```bash
curl -X POST localhost:8787/__control -d '{"faults":["http503","http503"]}'
```

| Fault | What the SDK should do |
|-------|------------------------|
| `http503`, `http500` | Retry, and count toward opening the breaker |
| `http400` | Fail fast, and **not** open the breaker |
| `html200` | Treat a 200-with-HTML as a failure, not a payment |
| `malformed` | Reject invalid JSON without retrying |
| `nonObject` | Reject a JSON primitive |
| `hang` | Abort on the client timeout and classify it as a timeout |

Arm exactly as many faults as requests that will reach the server. A call
the breaker refuses never arrives, so an extra armed fault stays queued and
will hit the next request instead.

Other control endpoints: `POST /__reset` clears all state,
`GET /__orders` lists what the gateway is holding, and
`POST /__notify?orderId=…` redelivers an order's callback the way the real
gateway does on a state change.

## Wire format

The mock defaults to **numeric** `errorCode` / `OrderStatus` / `actionCode`,
because that is what the live gateway sends — a bad-credential probe to
`test.satim.dz` answers `{"errorCode":5,"errorMessage":"Access denied"}`.
Requiring strings is what broke `validateRegisterSchema` before this mock
existed. Run with `WIRE_STYLE=string` to check the SDK handles both.

It also reproduces two details worth knowing:

- `register.do` returns lowercase `errorCode`; the order-management
  endpoints return capitalised `ErrorCode` / `OrderStatus`.
- `confirm` reads `mdOrder`, while `status`, `refund` and `reverse` read
  `orderId`.

## Local development and the SSRF guard

`returnUrl`, `failUrl` and `dynamicCallbackUrl` are validated against
private and loopback addresses, so `http://localhost:3000/callback` is
rejected by default. Opt in explicitly for local work:

```ts
satim.allowPrivateUrls(true).dynamicCallbackUrl("http://localhost:3000/callback")
```

Call it before the URL setters, and never in production. Obfuscated IP
encodings stay rejected either way.

Note the guard is lexical, not resolution-based, so a public hostname that
resolves to a private address still passes — the DNS-rebinding limitation
recorded in [SECURITY.md](../SECURITY.md).

## What this cannot tell you

The mock encodes the SDK's understanding of the gateway. Where that
understanding is wrong, the mock is wrong in exactly the same way, and both
will agree with each other. It cannot validate:

- Real 3-D Secure, issuer decisioning, or settlement timing.
- The gateway's true response shapes beyond what the SDK already assumes —
  in particular which fields a successful `register.do` actually returns.
- Whether `acknowledgeTransaction.do` behaves as this mock assumes on a
  pre-authorized order. The mock treats it as the capture operation,
  matching the SDK's own documentation, which means the webhook handler
  captures a hold as soon as a callback arrives. Confirm that against the
  real gateway during certification before relying on pre-auth.

Treat a green run as "the SDK is internally consistent and handles the
shapes we expect", not as certification.

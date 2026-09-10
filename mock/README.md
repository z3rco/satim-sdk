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

## Test cards

The card picked on the payment page decides the outcome.

| PAN | Outcome |
|-----|---------|
| `6280581000000000` | Approved |
| `6280581000000001` | Declined — insufficient funds |
| `6280581000000002` | Declined — 3-D Secure failed |
| `6280581000000003` | Session expired (`actionCode -2007`) |
| `6280581000000004` | Cancelled by cardholder (`actionCode 10`) |
| `6280581000000005` | Pre-authorized (hold, awaiting capture) |

Invented numbers. The `628058` prefix only makes them look plausible in logs.

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
**rejected** — correct in production, awkward locally. The demo uses
`shop.localtest.me`, which resolves to loopback while reading as an ordinary
public hostname. A `/etc/hosts` entry or an ngrok tunnel works too.

That the guard can be sidestepped this way is the DNS-rebinding limitation
already documented in [SECURITY.md](../SECURITY.md): the check is lexical,
not resolution-based.

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

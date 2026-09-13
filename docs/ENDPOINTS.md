# SATIM endpoint inventory

Probed against `test2.satim.dz`. Unauthenticated requests. A missing endpoint answers
HTTP 404; a deployed one answers with a gateway error, so 404 is the only reliable signal
for "absent". Endpoint names are case sensitive: a lowercase spelling 404s even when the
camelCase one exists.

Base path unless stated otherwise: `/payment/rest/`.

## 1. Present (19)

| Endpoint | Used by the SDK |
| - | - |
| `register.do` | `register()`, `safeRegister()` |
| `registerPreAuth.do` | `registerPreAuth()`, `safeRegisterPreAuth()` |
| `public/acknowledgeTransaction.do` | `confirm()` |
| `getOrderStatus.do` | `status()`, `statusAll()`, `warmup()`, capability control probe |
| `getOrderStatusExtended.do` | `statusExtended()` |
| `deposit.do` | `deposit()` |
| `refund.do` | `refund()` |
| `reverse.do` | `reverseOrder()` |
| `decline.do` | `decline()` |
| `confirmOrder.do` | no |
| `finish3ds.do` | no, the hosted form owns 3-D Secure |
| `bindCard.do` | no |
| `unBindCard.do` | no |
| `extendBinding.do` | no |
| `createBindingNoPayment.do` | no |
| `getBindings.do` | no |
| `getBindingsByCardOrId.do` | no |
| `paymentOrderBinding.do` | no |
| `paymentorder.do` | no |

`deposit.do`, `refund.do`, `reverse.do` and `decline.do` are deployed but permission gated
per merchant. Being present says nothing about your terminal being entitled to call them.
Use `checkCapabilities()`.

## 2. Absent, HTTP 404 (30)

```
Finish3dsVer2Payment.do   acsRedirect.do            applepay_payment.do
applepay_paymentdirect.do bindcard.do               cancel.do
continue.do               createttask_wheel.do      doesNotExist.do
extendbinding.do          finish3dsVer2Payment.do   getbindings.do
getbindingsbycardorid.do  gettask_wheel.do          google_payment.do
google_paymentdirect.do   installment_payment.do    instantPayment.do
instantRefund.do          instantpayment.do         motoPayment.do
motopayment.do            recurrent_payment.do      samsung_payment.do
samsung_paymentdirect.do  terminatetask_wheel.do    tokenpayment.do
unbindcard.do             verifyCard.do             verifycard.do
```

`doesNotExist.do` is the control: it confirms 404 is what an absent endpoint returns.

## 3. Paths outside `/payment/rest/`

An earlier pass probed only under `/payment/rest/` and recorded the wallet, recurring and
installment endpoints as absent. That reasoning was wrong: BPC places them under
`/payment/` directly. Re-probed at their documented paths, all absent (404):

```
/payment/acsRedirect.do                    /payment/recurrentPayment.do
/payment/installmentPayment.do             /payment/applepay/payment.do
/payment/applepay/paymentDirect.do         /payment/google/payment.do
/payment/google/paymentDirect.do           /payment/samsung/payment.do
/payment/samsung/paymentDirect.do          /payment/token/payment.do
/payment/industryPractice/paymentOrder.do  /payment/rest/3ds/continue.do
```

Conclusion holds after the correction: SATIM exposes no wallet, recurring, or installment
payment. The earlier verdict was right for the wrong reason. Endpoint names and path
prefixes both matter.

## 4. Callback notifications

Delivered as query parameters on `dynamicCallbackUrl`:

```
?mdOrder=<orderId>&orderNumber=<merchant order number>&operation=deposited&status=1
```

| Parameter | Note |
| - | - |
| `mdOrder` | the gateway order id. Not named `orderId` on this path |
| `orderNumber` | the merchant order number sent at registration |
| `operation` | for example `deposited` |
| `status` | gateway delivered status flag, not `OrderStatus` |
| `checksum` | present only when the merchant profile is configured for signing. HMAC-SHA256, see `callbackSecret` on `WebhookHandler` |

The SDK reads only the order id from this payload and re-fetches authoritative state. The
other parameters are informational and are not trusted.

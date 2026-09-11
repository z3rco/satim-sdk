# SATIM endpoint inventory (probed against test2.satim.dz)

Unauthenticated probes. A missing endpoint returns HTTP 404; a deployed
one answers with a gateway error, so 404 is the only reliable 'absent'.
Endpoint names are case-sensitive — lowercase spellings 404 even when the
camelCase one exists.

## Present (19)

- `bindCard.do`
- `confirmOrder.do`
- `createBindingNoPayment.do`
- `decline.do`
- `deposit.do`
- `extendBinding.do`
- `finish3ds.do`
- `getBindings.do`
- `getBindingsByCardOrId.do`
- `getOrderStatus.do`
- `getOrderStatusExtended.do`
- `paymentOrderBinding.do`
- `paymentorder.do`
- `public/acknowledgeTransaction.do`
- `refund.do`
- `register.do`
- `registerPreAuth.do`
- `reverse.do`
- `unBindCard.do`

## Absent — HTTP 404 (30)

- `Finish3dsVer2Payment.do`
- `acsRedirect.do`
- `applepay_payment.do`
- `applepay_paymentdirect.do`
- `bindcard.do`
- `cancel.do`
- `continue.do`
- `createttask_wheel.do`
- `doesNotExist.do`
- `extendbinding.do`
- `finish3dsVer2Payment.do`
- `getbindings.do`
- `getbindingsbycardorid.do`
- `gettask_wheel.do`
- `google_payment.do`
- `google_paymentdirect.do`
- `installment_payment.do`
- `instantPayment.do`
- `instantRefund.do`
- `instantpayment.do`
- `motoPayment.do`
- `motopayment.do`
- `recurrent_payment.do`
- `samsung_payment.do`
- `samsung_paymentdirect.do`
- `terminatetask_wheel.do`
- `tokenpayment.do`
- `unbindcard.do`
- `verifyCard.do`
- `verifycard.do`

## Correction: paths outside `/payment/rest/`

An earlier pass probed everything under `/payment/rest/` and marked the
wallet, recurring and installment endpoints absent. That was wrong — BPC
puts them under `/payment/` directly. Re-probed at their documented paths:

- `/payment/acsRedirect.do` — absent (404)
- `/payment/recurrentPayment.do` — absent (404)
- `/payment/installmentPayment.do` — absent (404)
- `/payment/applepay/payment.do` — absent (404)
- `/payment/applepay/paymentDirect.do` — absent (404)
- `/payment/google/payment.do` — absent (404)
- `/payment/google/paymentDirect.do` — absent (404)
- `/payment/samsung/payment.do` — absent (404)
- `/payment/samsung/paymentDirect.do` — absent (404)
- `/payment/token/payment.do` — absent (404)
- `/payment/industryPractice/paymentOrder.do` — absent (404)
- `/payment/rest/3ds/continue.do` — absent (404)

So the conclusion survives the correction: SATIM does not expose wallet,
recurring or installment payments, and the earlier verdict was right for
the wrong reason. Endpoint names and path prefixes both matter.

## Callback notifications

Notifications arrive as query parameters on `dynamicCallbackUrl`, e.g.
`?mdOrder=…&orderNumber=…&operation=deposited&status=1`. Note `mdOrder`,
not `orderId`. When the merchant profile is configured for signing they
also carry `checksum` (HMAC-SHA256); see `callbackSecret` on
`WebhookHandler`.

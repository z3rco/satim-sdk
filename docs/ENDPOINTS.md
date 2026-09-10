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

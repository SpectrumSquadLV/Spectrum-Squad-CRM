import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { handlePaymentEvent } from '@/features/commerce/fulfilment'
import { requestOrigin } from '@/lib/auth/env'
import { paymentProvider } from '@/lib/payments'

/**
 * The payment webhook.
 *
 * This endpoint is public — it has to be, the provider calls it — so the
 * signature is the only thing standing between an anonymous HTTP request and a
 * free $1,000 programme. It is verified before the body is looked at, and a
 * failure returns 400 without touching the database.
 *
 * Always 200 on a verified event, even one we do nothing with. A non-2xx tells
 * the provider to retry, and retrying an event we deliberately ignored just
 * fills their queue.
 */
export async function POST(request: Request) {
  const signature =
    request.headers.get('stripe-signature') ??
    request.headers.get('x-payment-signature') ??
    ''

  // The RAW body: any reserialisation changes the bytes and the signature
  // stops matching.
  const rawBody = await request.text()

  let event
  try {
    event = await paymentProvider().parseWebhook(rawBody, signature)
  } catch (error) {
    /*
     * A rejected signature has to be LOUD on our side and vague on theirs.
     *
     * This used to be a bare `catch` that returned 400 and recorded nothing,
     * which hid the single worst failure this product can have. Stripe's
     * webhook secrets are `whsec_...` in both live and test mode with nothing
     * in the string to tell them apart, so pairing a live key with a
     * test-mode secret is undetectable from the environment - and its symptom
     * is exactly this rejection. Her card is really charged, this returns
     * 400, fulfilment never runs, and she has paid real money for nothing.
     *
     * Silently. The server logs stay completely empty, so the only way anyone
     * finds out is a woman writing in to ask where her programme is.
     *
     * The response stays deliberately unspecific, because a precise error
     * tells a forger what to fix. The log is where the truth goes.
     */
    console.error('[webhook] SIGNATURE REJECTED — nothing was fulfilled', {
      hasSignature: signature.length > 0,
      bodyBytes: rawBody.length,
      // Whether the secret is even the right SHAPE, without printing it.
      secretConfigured: (process.env.STRIPE_WEBHOOK_SECRET ?? '').startsWith(
        'whsec_',
      ),
      hint:
        'If a real payment just succeeded in Stripe, STRIPE_WEBHOOK_SECRET is ' +
        'almost certainly from the wrong MODE. Live keys need the secret from ' +
        'the live-mode endpoint. The buyer has been charged and has no access.',
      error,
    })
    return NextResponse.json({ error: 'invalid' }, { status: 400 })
  }

  try {
    /*
     * Resolved from the headers of the provider's own call, not from
     * NEXT_PUBLIC_SITE_URL, so the "go to your practice" link in her receipt
     * points where she can actually reach.
     */
    const result = await handlePaymentEvent(db, event, await requestOrigin())
    return NextResponse.json({ received: true, ...result })
  } catch (error) {
    /*
     * Verified, and we failed to apply it. Also previously silent.
     *
     * This is the other half of "she paid and got nothing", and it is the
     * half where the signature was fine - so the misconfiguration hint above
     * would be wrong and this needs its own line. 500 asks for a retry, and
     * fulfilment is idempotent, so a retry is safe; but if every retry fails
     * the same way, the retries stop and nobody is told.
     */
    console.error('[webhook] VERIFIED EVENT FAILED TO FULFIL', {
      eventId: event.id,
      eventType: event.type,
      orderId: event.orderId,
      error,
    })
    return NextResponse.json({ error: 'fulfilment failed' }, { status: 500 })
  }
}

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
  } catch {
    // Deliberately unspecific: a precise error tells a forger what to fix.
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
  } catch {
    // Verified but we failed to apply it. 500 asks for a retry, and
    // fulfilment is idempotent, so a retry is safe.
    return NextResponse.json({ error: 'fulfilment failed' }, { status: 500 })
  }
}

import 'server-only'

import { createFakeProvider } from './fake'
import type { PaymentProvider } from './provider'
import { stripeProvider } from './stripe'

/**
 * Which provider the app uses.
 *
 * Stripe unless PAYMENTS_PROVIDER says otherwise - and the fake is refused
 * outright in production, because a provider that always reports success would
 * hand out paid programmes for free.
 */
export function paymentProvider(): PaymentProvider {
  const configured = process.env.PAYMENTS_PROVIDER ?? 'stripe'

  if (configured === 'fake') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'PAYMENTS_PROVIDER=fake is refused in production. It approves every payment.',
      )
    }
    return createFakeProvider(process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_fake')
      .provider
  }

  return stripeProvider
}

export * from './provider'

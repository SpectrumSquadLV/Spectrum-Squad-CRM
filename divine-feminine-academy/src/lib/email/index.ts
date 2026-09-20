import 'server-only'

import { createFakeEmailProvider } from './fake'
import type { EmailProvider } from './provider'
import { resendProvider } from './resend'

/**
 * Which email provider the app uses.
 *
 * Unlike the payment provider, the fake IS allowed in production — but only
 * when no Resend key is configured, and it logs loudly. A half-configured
 * deployment silently dropping her sign-in link is worse than one that says so.
 */
export function emailProvider(): EmailProvider {
  if (process.env.EMAIL_PROVIDER === 'fake' || !process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[email] No RESEND_API_KEY. Emails are being DISCARDED, including sign-in links.',
      )
    }
    return createFakeEmailProvider().provider
  }
  return resendProvider
}

export * from './provider'

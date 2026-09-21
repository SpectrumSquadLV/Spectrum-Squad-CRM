import type { EmailProvider, OutgoingEmail, SendResult } from './provider'

/**
 * An email provider that delivers to an array.
 *
 * This is how the automation engine and the reminder job are tested: nothing
 * is sent, but everything that WOULD be sent is inspectable.
 */
export function createFakeEmailProvider() {
  const sent: OutgoingEmail[] = []
  let counter = 0

  const provider: EmailProvider = {
    name: 'fake',
    async send(email: OutgoingEmail): Promise<SendResult> {
      counter++
      sent.push(email)
      return { messageId: `msg_fake_${counter}` }
    },
  }

  return { provider, sent, reset: () => void (sent.length = 0) }
}

import 'server-only'

import { EmailError, type EmailProvider, type OutgoingEmail, type SendResult } from './provider'

/**
 * Resend, over its REST API.
 *
 * No SDK: this is one POST, and keeping the dependency out means one less
 * thing to keep current.
 */
const API = 'https://api.resend.com/emails'

function apiKey(): string {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new EmailError('RESEND_API_KEY is not set.')
  return key
}

function fromAddress(): string {
  const from = process.env.EMAIL_FROM
  if (!from) throw new EmailError('EMAIL_FROM is not set.')
  return from
}

export const resendProvider: EmailProvider = {
  name: 'resend',

  async send(email: OutgoingEmail): Promise<SendResult> {
    const response = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        // Resend honours this, so a retried send does not arrive twice.
        ...(email.idempotencyKey
          ? { 'Idempotency-Key': email.idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        ...(email.tags
          ? {
              tags: Object.entries(email.tags).map(([name, value]) => ({
                name,
                value,
              })),
            }
          : {}),
      }),
    })

    const json = (await response.json()) as Record<string, unknown>

    if (!response.ok) {
      const message =
        typeof json.message === 'string'
          ? json.message
          : `Resend returned ${response.status}`
      throw new EmailError(message, json)
    }

    const id = typeof json.id === 'string' ? json.id : null
    if (!id) throw new EmailError('Resend did not return a message id.', json)

    return { messageId: id }
  },
}

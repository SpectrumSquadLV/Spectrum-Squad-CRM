/**
 * The email provider interface.
 *
 * Same shape as the payment provider, and for the same two reasons: Resend is
 * swappable, and there is a fake implementation so everything that sends email
 * can be tested without the network or a real inbox.
 */

export interface OutgoingEmail {
  to: string
  subject: string
  html: string
  text: string
  /** Deduplicates at the provider too, where supported. */
  idempotencyKey?: string
  replyTo?: string
  tags?: Record<string, string>
}

export interface SendResult {
  messageId: string
}

export interface EmailProvider {
  readonly name: string
  send(email: OutgoingEmail): Promise<SendResult>
}

export class EmailError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'EmailError'
  }
}

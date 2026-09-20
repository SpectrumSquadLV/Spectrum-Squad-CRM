/**
 * The payment provider interface.
 *
 * Everything the app needs from a payment processor, and nothing it does not.
 * Two reasons this exists rather than calling Stripe directly:
 *
 *   1. Card details never touch our servers. We hand off to a hosted checkout
 *      and are told what happened afterwards.
 *   2. Stripe is swappable. The rest of the codebase knows about orders and
 *      payments, not about Stripe.
 *
 * The fake provider in ./fake.ts implements the same interface, which is how
 * checkout and fulfilment are tested without the network.
 */

export interface CheckoutLineItem {
  name: string
  description?: string
  amountCents: number
  currency: string
  quantity: number
}

export interface CreateCheckoutInput {
  orderId: string
  contactEmail: string
  lineItems: CheckoutLineItem[]
  successUrl: string
  cancelUrl: string
  /** Echoed back on the webhook so fulfilment knows what was bought. */
  metadata: Record<string, string>
  /** A payment plan charges the first instalment now and schedules the rest. */
  mode: 'payment' | 'subscription'
}

export interface CheckoutSession {
  /** Where to send her to pay. */
  url: string
  sessionId: string
}

export interface RefundInput {
  paymentIntentId: string
  amountCents: number
  reason?: string
}

export interface RefundResult {
  refundId: string
  amountCents: number
}

/**
 * A payment event, normalised away from any one provider's vocabulary.
 *
 * `id` is the provider's event id and is what makes fulfilment idempotent:
 * providers retry webhooks, and a retry must not enrol her twice or grant a
 * second certificate.
 */
export interface PaymentEvent {
  id: string
  type:
    | 'checkout.completed'
    | 'payment.succeeded'
    | 'payment.failed'
    | 'refund.created'
    | 'subscription.cancelled'
    | 'unknown'
  orderId: string | null
  sessionId: string | null
  paymentIntentId: string | null
  customerId: string | null
  amountCents: number | null
  currency: string | null
  failureReason: string | null
  metadata: Record<string, string>
  raw: unknown
}

export interface PaymentProvider {
  readonly name: string
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>
  refund(input: RefundInput): Promise<RefundResult>
  /**
   * Verify a webhook and normalise it.
   *
   * Throws if the signature does not verify. An unverified webhook is an
   * anonymous request claiming somebody paid, so this must never be skipped.
   */
  parseWebhook(rawBody: string, signature: string): Promise<PaymentEvent>
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'PaymentProviderError'
  }
}

export class WebhookVerificationError extends Error {
  constructor(message = 'Webhook signature did not verify.') {
    super(message)
    this.name = 'WebhookVerificationError'
  }
}

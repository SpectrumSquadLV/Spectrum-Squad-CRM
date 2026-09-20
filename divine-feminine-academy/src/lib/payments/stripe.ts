import 'server-only'

import {
  PaymentProviderError,
  type CheckoutSession,
  type CreateCheckoutInput,
  type PaymentEvent,
  type PaymentProvider,
  type RefundInput,
  type RefundResult,
} from './provider'
import { verifySignature } from './signature'

/**
 * Stripe, over its REST API.
 *
 * Deliberately no SDK: everything needed here is three form-encoded POSTs and
 * a signature check, and the signature check is something worth being able to
 * test rather than delegate.
 *
 * Card details never reach this server. We create a hosted Checkout Session,
 * send her to it, and find out what happened from the webhook.
 */
const API = 'https://api.stripe.com/v1'

function secretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new PaymentProviderError(
      'STRIPE_SECRET_KEY is not set. Checkout cannot run without it.',
    )
  }
  return key
}

function webhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    throw new PaymentProviderError('STRIPE_WEBHOOK_SECRET is not set.')
  }
  return secret
}

/** Stripe takes form encoding with bracketed paths, not JSON. */
function encode(
  value: unknown,
  prefix = '',
  out: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  if (value === null || value === undefined) return out

  if (Array.isArray(value)) {
    value.forEach((item, i) => encode(item, `${prefix}[${i}]`, out))
    return out
  }

  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      encode(item, prefix ? `${prefix}[${key}]` : key, out)
    }
    return out
  }

  out.append(prefix, String(value))
  return out
}

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: encode(body).toString(),
  })

  const json = (await response.json()) as Record<string, unknown>

  if (!response.ok) {
    const error = json.error as { message?: string } | undefined
    throw new PaymentProviderError(
      error?.message ?? `Stripe returned ${response.status}`,
      json,
    )
  }

  return json
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Stripe nests the intent id when a session is expanded, and not otherwise. */
function intentIdFrom(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    return asString((value as Record<string, unknown>).id)
  }
  return null
}

export const stripeProvider: PaymentProvider = {
  name: 'stripe',

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const session = await post('/checkout/sessions', {
      mode: input.mode,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      customer_email: input.contactEmail,
      client_reference_id: input.orderId,
      metadata: { ...input.metadata, orderId: input.orderId },
      // Carried onto the PaymentIntent too, so a webhook about the payment
      // rather than the session can still be traced back to the order.
      payment_intent_data:
        input.mode === 'payment'
          ? { metadata: { ...input.metadata, orderId: input.orderId } }
          : undefined,
      line_items: input.lineItems.map((item) => ({
        quantity: item.quantity,
        price_data: {
          currency: item.currency,
          unit_amount: item.amountCents,
          product_data: {
            name: item.name,
            description: item.description,
          },
        },
      })),
    })

    const url = asString(session.url)
    const id = asString(session.id)
    if (!url || !id) {
      throw new PaymentProviderError('Stripe did not return a checkout URL.', session)
    }

    return { url, sessionId: id }
  },

  async refund(input: RefundInput): Promise<RefundResult> {
    const refund = await post('/refunds', {
      payment_intent: input.paymentIntentId,
      amount: input.amountCents,
      ...(input.reason ? { metadata: { reason: input.reason } } : {}),
    })

    const id = asString(refund.id)
    if (!id) throw new PaymentProviderError('Stripe did not return a refund id.', refund)

    return {
      refundId: id,
      amountCents:
        typeof refund.amount === 'number' ? refund.amount : input.amountCents,
    }
  },

  async parseWebhook(rawBody: string, signature: string): Promise<PaymentEvent> {
    // Throws unless it verifies. Never skip this.
    verifySignature(rawBody, signature, webhookSecret())

    const event = JSON.parse(rawBody) as Record<string, unknown>
    const data = (event.data as Record<string, unknown> | undefined)?.object as
      | Record<string, unknown>
      | undefined

    const metadata = (data?.metadata ?? {}) as Record<string, string>
    const stripeType = asString(event.type) ?? ''

    const type: PaymentEvent['type'] =
      stripeType === 'checkout.session.completed'
        ? 'checkout.completed'
        : stripeType === 'payment_intent.succeeded' ||
            stripeType === 'invoice.payment_succeeded'
          ? 'payment.succeeded'
          : stripeType === 'payment_intent.payment_failed' ||
              stripeType === 'invoice.payment_failed'
            ? 'payment.failed'
            : stripeType === 'charge.refunded' || stripeType === 'refund.created'
              ? 'refund.created'
              : stripeType === 'customer.subscription.deleted'
                ? 'subscription.cancelled'
                : 'unknown'

    const lastError = data?.last_payment_error as
      | { message?: string }
      | undefined

    return {
      id: asString(event.id) ?? '',
      type,
      orderId: metadata.orderId ?? asString(data?.client_reference_id),
      sessionId:
        stripeType === 'checkout.session.completed' ? asString(data?.id) : null,
      paymentIntentId:
        intentIdFrom(data?.payment_intent) ??
        (stripeType.startsWith('payment_intent') ? asString(data?.id) : null),
      customerId: asString(data?.customer),
      amountCents:
        typeof data?.amount_total === 'number'
          ? data.amount_total
          : typeof data?.amount === 'number'
            ? data.amount
            : typeof data?.amount_refunded === 'number'
              ? data.amount_refunded
              : null,
      currency: asString(data?.currency),
      failureReason: lastError?.message ?? null,
      metadata,
      raw: event,
    }
  },
}

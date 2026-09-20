import {
  type CheckoutSession,
  type CreateCheckoutInput,
  type PaymentEvent,
  type PaymentProvider,
  type RefundInput,
  type RefundResult,
} from './provider'
import { computeSignature, verifySignature } from './signature'

/**
 * A payment provider that does not talk to anybody.
 *
 * This is how checkout and fulfilment get tested: the same interface, the same
 * webhook shape, the same signature scheme - without the network and without a
 * Stripe account. It is NEVER selected in production; see ./index.ts.
 */
export interface FakeProviderState {
  checkouts: Array<{ input: CreateCheckoutInput; sessionId: string }>
  refunds: Array<RefundInput & { refundId: string }>
}

export function createFakeProvider(secret = 'whsec_fake') {
  const state: FakeProviderState = { checkouts: [], refunds: [] }
  let counter = 0

  const provider: PaymentProvider = {
    name: 'fake',

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
      counter++
      const sessionId = `cs_fake_${counter}`
      state.checkouts.push({ input, sessionId })
      return { url: `https://checkout.test/${sessionId}`, sessionId }
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      counter++
      const refundId = `re_fake_${counter}`
      state.refunds.push({ ...input, refundId })
      return { refundId, amountCents: input.amountCents }
    },

    async parseWebhook(rawBody: string, signature: string): Promise<PaymentEvent> {
      verifySignature(rawBody, signature, secret)
      return JSON.parse(rawBody) as PaymentEvent
    },
  }

  /** Build a correctly signed webhook body, the way the real provider would. */
  function sign(event: PaymentEvent, timestamp = Math.floor(Date.now() / 1000)) {
    const body = JSON.stringify(event)
    return {
      body,
      header: `t=${timestamp},v1=${computeSignature(body, timestamp, secret)}`,
    }
  }

  return { provider, state, sign, secret }
}

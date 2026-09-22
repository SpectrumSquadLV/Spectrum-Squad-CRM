'use server'

import { and, eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/db/client'
import {
  activityEvents,
  contacts,
  coupons,
  crmStages,
  offers,
  orderItems,
  orders,
  programs,
} from '@/db/schema'
import { getCohortById } from '@/db/queries/cohorts'
import { getActor } from '@/lib/auth/actor-server'
import { requestOrigin } from '@/lib/auth/env'
import { paymentProvider } from '@/lib/payments'
import { installmentSchedule, priceOrder, type Coupon, type Offer } from './pricing'

export type CheckoutState = { error?: string }

const schema = z.object({
  offerId: z.string().uuid('That offer does not exist.'),
  cohortId: z.string().uuid().optional(),
  email: z.string().trim().toLowerCase().email('That address does not look right.'),
  firstName: z.string().trim().max(80).optional(),
  couponCode: z.string().trim().max(64).optional(),
})

function toOffer(row: typeof offers.$inferSelect): Offer {
  return {
    id: row.id,
    pricingType: row.pricingType,
    priceCents: row.priceCents,
    currency: row.currency,
    installments: row.installments,
    installmentIntervalDays: row.installmentIntervalDays,
    refundWindowDays: row.refundWindowDays,
  }
}

function toCoupon(row: typeof coupons.$inferSelect): Coupon {
  return {
    id: row.id,
    code: row.code,
    discountType: row.discountType,
    discountValue: row.discountValue,
    offerId: row.offerId,
    maxRedemptions: row.maxRedemptions,
    redemptionCount: row.redemptionCount,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    isActive: row.isActive,
  }
}

/**
 * Start checkout.
 *
 * The price is computed HERE from the stored offer and the stored coupon.
 * Nothing about the amount comes from the browser — otherwise a crafted
 * request could buy the Divine Feminine for a penny.
 */
export async function startCheckout(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }
  const input = parsed.data

  const [offerRow] = await db
    .select({ offer: offers, program: programs })
    .from(offers)
    .innerJoin(programs, eq(programs.id, offers.programId))
    .where(and(eq(offers.id, input.offerId), eq(offers.status, 'active')))
    .limit(1)

  if (!offerRow) return { error: 'That offer is not available.' }

  const offer = toOffer(offerRow.offer)

  let couponRow: typeof coupons.$inferSelect | undefined
  if (input.couponCode) {
    const [found] = await db
      .select()
      .from(coupons)
      .where(eq(coupons.code, input.couponCode.toUpperCase()))
      .limit(1)
    couponRow = found
  }

  const now = new Date()

  /*
   * The doors are checked HERE, on the server, at the moment of payment.
   *
   * The countdown on the page is a picture. It can be stale, the tab can have
   * been open all afternoon, and the clock on her laptop can be wrong. If this
   * were not re-checked, a woman could pay for a seat in a room that shut an
   * hour ago — which means taking money for something she cannot have, which
   * is the worst failure this system is capable of.
   */
  let cohortId: string | null = null
  if (input.cohortId) {
    const detail = await getCohortById(db, input.cohortId, now)
    if (!detail) return { error: 'That group does not exist.' }
    if (detail.cohort.offerId !== offer.id) {
      return { error: 'That is not the price for this group.' }
    }
    if (!detail.window.canEnroll) {
      return {
        error:
          detail.window.phase === 'full'
            ? 'Every seat in that group is taken. Join the waitlist and you are first to know.'
            : 'The doors on that group are closed.',
      }
    }
    cohortId = detail.cohort.id
  }

  const pricing = priceOrder(offer, couponRow ? toCoupon(couponRow) : null, now)

  if (input.couponCode && !pricing.couponApplied) {
    return { error: 'That code is not valid for this.' }
  }

  // One canonical person, whether she has an account yet or not.
  const actor = await getActor()
  let contactId =
    actor.kind === 'user' && actor.contactId ? actor.contactId : undefined

  if (!contactId) {
    const [existing] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, input.email))
      .limit(1)
    contactId = existing?.id

    if (!contactId) {
      const [defaultStage] = await db
        .select({ id: crmStages.id })
        .from(crmStages)
        .where(eq(crmStages.isDefault, true))
        .limit(1)

      const [created] = await db
        .insert(contacts)
        .values({
          email: input.email,
          firstName: input.firstName || null,
          acquisitionSource: `checkout:${offerRow.program.slug}`,
          crmStageId: defaultStage?.id ?? null,
          lastActivityAt: now,
        })
        .returning({ id: contacts.id })
      contactId = created?.id
    }
  }

  if (!contactId) return { error: 'That did not work. Try again.' }

  const [order] = await db
    .insert(orders)
    .values({
      contactId,
      status: 'pending',
      subtotalCents: pricing.subtotalCents,
      discountCents: pricing.discountCents,
      totalCents: pricing.totalCents,
      currency: pricing.currency,
      couponId: pricing.couponApplied ? (couponRow?.id ?? null) : null,
      cohortId,
    })
    .returning()

  if (!order) return { error: 'That did not work. Try again.' }

  await db.insert(orderItems).values({
    orderId: order.id,
    offerId: offer.id,
    quantity: 1,
    unitPriceCents: pricing.totalCents,
  })

  await db.insert(activityEvents).values({
    contactId,
    eventType: 'checkout.started',
    entity: 'orders',
    entityId: order.id,
    metadata: { offerId: offer.id, totalCents: pricing.totalCents },
  })

  // A free order has nothing to charge; it is fulfilled straight away by the
  // same path a paid one takes, so access is granted exactly once.
  if (pricing.totalCents === 0) {
    const { handlePaymentEvent } = await import('./fulfilment')
    await handlePaymentEvent(db, {
      id: `free_${order.id}`,
      type: 'checkout.completed',
      orderId: order.id,
      sessionId: null,
      paymentIntentId: null,
      customerId: null,
      amountCents: 0,
      currency: pricing.currency,
      failureReason: null,
      metadata: { orderId: order.id },
      raw: null,
    })
    redirect(`/checkout/complete?order=${order.id}`)
  }

  // A payment plan charges the first instalment now; the schedule tells her
  // what is coming, and the provider handles the rest.
  const schedule = installmentSchedule(offer, pricing.totalCents, now)
  const first = schedule[0]
  if (!first) return { error: 'That offer is not priced correctly.' }

  const planNote =
    schedule.length > 1
      ? `Payment ${first.number} of ${schedule.length}`
      : undefined

  /*
   * Where Stripe sends her back, resolved from THIS request.
   *
   * It used to be siteUrl(), which reads NEXT_PUBLIC_SITE_URL - inlined at
   * BUILD time. So the two most important links in the whole purchase carried
   * whatever that variable said when the image was built, and a woman who
   * paid on one hostname could be returned to a different one that may not
   * even answer. Exactly the bug that sent magic links to localhost, sitting
   * in the return leg of checkout where it costs money rather than a login.
   */
  const origin = await requestOrigin()

  let checkout
  try {
    checkout = await paymentProvider().createCheckout({
      orderId: order.id,
      contactEmail: input.email,
      mode: 'payment',
      successUrl: `${origin}/checkout/complete?order=${order.id}`,
      cancelUrl: `${origin}/checkout/cancelled?order=${order.id}`,
      metadata: { orderId: order.id, offerId: offer.id },
      lineItems: [
        {
          name: offerRow.program.title,
          description: planNote ?? offerRow.offer.name,
          amountCents: first.amountCents,
          currency: pricing.currency,
          quantity: 1,
        },
      ],
    })
  } catch (error) {
    /*
     * The provider said WHY, and this used to throw that away.
     *
     * A bare `catch {}` here meant a failed checkout produced one vague
     * sentence on screen and absolutely nothing anywhere else - no log, no
     * trace, nothing to search. The first real failure was undiagnosable
     * from outside, which is the worst possible property for the one screen
     * that takes money.
     *
     * She still sees the vague sentence: a Stripe error string on a public
     * page tells a stranger about the account's configuration. But the
     * server now records the whole thing.
     */
    console.error('[checkout] provider refused to create a session', {
      orderId: order.id,
      offerId: offer.id,
      error,
    })
    return { error: 'Checkout is not available right now. Nothing was charged.' }
  }

  await db
    .update(orders)
    .set({ stripeCheckoutSessionId: checkout.sessionId, updatedAt: new Date() })
    .where(eq(orders.id, order.id))

  redirect(checkout.url)
}

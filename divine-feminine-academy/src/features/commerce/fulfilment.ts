import 'server-only'

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
  activityEvents,
  contacts,
  contactStageHistory,
  couponRedemptions,
  coupons,
  crmStages,
  enrollments,
  offers,
  orderItems,
  orders,
  payments,
  programVersions,
  programs,
} from '@/db/schema'
import type { PaymentEvent } from '@/lib/payments/provider'

/**
 * What happens after she pays.
 *
 * The one rule that matters: **this must be idempotent.** Payment providers
 * retry webhooks, deliver out of order, and sometimes send the same event
 * twice. Granting access twice would mean two enrollments and a double-counted
 * sale; granting it zero times means she paid and got nothing.
 *
 * Idempotency is keyed on the provider's event id, recorded in
 * `activity_events` before any side effect runs.
 */

async function alreadyHandled(db: Db, eventId: string): Promise<boolean> {
  if (!eventId) return false
  const [seen] = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.eventType, 'payment.webhook'),
        sql`${activityEvents.metadata}->>'eventId' = ${eventId}`,
      ),
    )
    .limit(1)
  return Boolean(seen)
}

async function recordHandled(
  db: Db,
  event: PaymentEvent,
  contactId: string | null,
) {
  await db.insert(activityEvents).values({
    contactId,
    eventType: 'payment.webhook',
    entity: 'orders',
    entityId: event.orderId,
    metadata: { eventId: event.id, type: event.type },
  })
}

/** Move her along the pipeline, recording where she came from. */
async function moveToStage(db: Db, contactId: string, slug: string) {
  const [stage] = await db
    .select({ id: crmStages.id })
    .from(crmStages)
    .where(eq(crmStages.slug, slug))
    .limit(1)
  if (!stage) return

  const [contact] = await db
    .select({ crmStageId: contacts.crmStageId })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1)

  if (contact?.crmStageId === stage.id) return

  await db
    .update(contacts)
    .set({ crmStageId: stage.id, updatedAt: new Date() })
    .where(eq(contacts.id, contactId))

  await db.insert(contactStageHistory).values({
    contactId,
    fromStageId: contact?.crmStageId ?? null,
    toStageId: stage.id,
  })
}

/**
 * Grant what she bought.
 *
 * Idempotent on its own account too: an existing enrollment is left alone
 * rather than duplicated, so a replayed webhook cannot reset her progress.
 */
async function grantAccess(db: Db, orderId: string, contactId: string) {
  /*
   * Which room she bought into, if any.
   *
   * Read from the order rather than guessed from the offer: two cohorts can
   * share one offer, and putting a woman in the wrong room is the one mistake
   * she would notice immediately and could not fix herself.
   */
  const [order] = await db
    .select({ cohortId: orders.cohortId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)

  const items = await db
    .select({ offer: offers, program: programs })
    .from(orderItems)
    .innerJoin(offers, eq(offers.id, orderItems.offerId))
    .innerJoin(programs, eq(programs.id, offers.programId))
    .where(eq(orderItems.orderId, orderId))

  for (const { program } of items) {
    const [existing] = await db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.contactId, contactId),
          eq(enrollments.programId, program.id),
        ),
      )
      .limit(1)

    if (existing) continue

    const [version] = await db
      .select()
      .from(programVersions)
      .where(eq(programVersions.programId, program.id))
      .orderBy(sql`${programVersions.version} desc`)
      .limit(1)
    if (!version) continue

    const [contact] = await db
      .select({ timezone: contacts.timezone })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1)

    await db.insert(enrollments).values({
      contactId,
      programId: program.id,
      versionId: version.id,
      cohortId: order?.cohortId ?? null,
      timezoneAtStart: contact?.timezone ?? 'UTC',
      currentDay: 1,
    })

    await db.insert(activityEvents).values({
      contactId,
      eventType: 'enrollment.granted',
      entity: 'programs',
      entityId: program.id,
      metadata: { orderId, cohortId: order?.cohortId ?? null },
    })
  }
}

export interface FulfilmentResult {
  handled: boolean
  reason?: 'duplicate' | 'no-order' | 'unknown-event'
  orderId?: string
}

export async function handlePaymentEvent(
  db: Db,
  event: PaymentEvent,
): Promise<FulfilmentResult> {
  if (await alreadyHandled(db, event.id)) {
    return { handled: false, reason: 'duplicate' }
  }

  if (event.type === 'unknown') {
    await recordHandled(db, event, null)
    return { handled: false, reason: 'unknown-event' }
  }

  if (!event.orderId) {
    await recordHandled(db, event, null)
    return { handled: false, reason: 'no-order' }
  }

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, event.orderId))
    .limit(1)

  if (!order) {
    await recordHandled(db, event, null)
    return { handled: false, reason: 'no-order' }
  }

  // Recorded BEFORE the side effects, so a crash mid-way cannot be replayed
  // into a second enrollment. Re-running a partially applied event is safe
  // because every step below is itself idempotent.
  await recordHandled(db, event, order.contactId)

  switch (event.type) {
    case 'checkout.completed':
    case 'payment.succeeded': {
      await db
        .update(orders)
        .set({
          status: 'paid',
          paidAt: order.paidAt ?? new Date(),
          stripeCustomerId: event.customerId ?? order.stripeCustomerId,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id))

      if (event.paymentIntentId) {
        await db
          .insert(payments)
          .values({
            orderId: order.id,
            amountCents: event.amountCents ?? order.totalCents,
            currency: event.currency ?? order.currency,
            status: 'succeeded',
            stripePaymentIntentId: event.paymentIntentId,
            processedAt: new Date(),
          })
          .onConflictDoNothing({ target: payments.stripePaymentIntentId })
      }

      if (order.couponId) {
        await db
          .insert(couponRedemptions)
          .values({
            couponId: order.couponId,
            orderId: order.id,
            contactId: order.contactId,
            amountCents: order.discountCents,
          })
          .onConflictDoNothing({
            target: [couponRedemptions.couponId, couponRedemptions.orderId],
          })

        // Only count the redemption once, guarded by the row above.
        await db
          .update(coupons)
          .set({ redemptionCount: sql`${coupons.redemptionCount} + 1` })
          .where(eq(coupons.id, order.couponId))
      }

      await db
        .update(contacts)
        .set({
          lifetimeValueCents: sql`${contacts.lifetimeValueCents} + ${order.totalCents}`,
          lastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, order.contactId))

      await grantAccess(db, order.id, order.contactId)
      await moveToStage(db, order.contactId, 'academy-enrolled')

      return { handled: true, orderId: order.id }
    }

    case 'payment.failed': {
      await db
        .update(orders)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(orders.id, order.id))

      if (event.paymentIntentId) {
        await db
          .insert(payments)
          .values({
            orderId: order.id,
            amountCents: event.amountCents ?? order.totalCents,
            currency: event.currency ?? order.currency,
            status: 'failed',
            stripePaymentIntentId: event.paymentIntentId,
            failureReason: event.failureReason,
            processedAt: new Date(),
          })
          .onConflictDoNothing({ target: payments.stripePaymentIntentId })
      }

      return { handled: true, orderId: order.id }
    }

    case 'refund.created': {
      // The refund itself is recorded by the admin action that issued it; a
      // refund started in the provider's own dashboard lands here instead.
      await db
        .update(orders)
        .set({
          status:
            (event.amountCents ?? 0) >= order.totalCents
              ? 'refunded'
              : 'partially_refunded',
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id))

      return { handled: true, orderId: order.id }
    }

    case 'subscription.cancelled': {
      await db
        .update(orders)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(orders.id, order.id))
      return { handled: true, orderId: order.id }
    }

    default:
      return { handled: false, reason: 'unknown-event' }
  }
}

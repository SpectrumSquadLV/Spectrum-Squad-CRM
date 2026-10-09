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
import { sendToContact } from '@/features/email/send'
import { orderReceipt } from '@/features/email/templates'
import type { PaymentEvent } from '@/lib/payments/provider'
import { siteUrl as configuredSiteUrl } from '@/lib/auth/env'
import { formatMoney } from './pricing'

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

/**
 * Tell her she is in, and give her the way back.
 *
 * She has just paid and closed the tab. The enrollment above is what lets her
 * in; this email is the only thing that tells her the door exists. Without it
 * a completed purchase looks, from her side, exactly like a payment that
 * vanished.
 *
 * Three things this must get right:
 *
 * `transactional`, not `lifecycle`. A receipt for money she has spent is owed
 * to her whether or not she wants the daily emails, and opting out of
 * encouragement is not opting out of proof of purchase.
 *
 * Once per order, ever. The idempotency key is the order, not the event, so a
 * provider that delivers `checkout.completed` and `payment.succeeded` for one
 * purchase — which Stripe does — sends her one receipt, not two.
 *
 * And it must never throw. `recordHandled` runs before the side effects, so a
 * throw here would return 500, the provider would retry, the retry would see
 * the event already handled and stop — leaving her with access she was never
 * told about and no second chance to tell her. A failed send is logged and
 * swallowed; access is already granted and that is the part she cannot
 * recover herself.
 */
async function sendReceipt(
  db: Db,
  orderId: string,
  contactId: string,
  site: string,
) {
  try {
    const [line] = await db
      .select({
        programTitle: programs.title,
        refundWindowDays: offers.refundWindowDays,
      })
      .from(orderItems)
      .innerJoin(offers, eq(offers.id, orderItems.offerId))
      .innerJoin(programs, eq(programs.id, offers.programId))
      .where(eq(orderItems.orderId, orderId))
      .limit(1)

    if (!line) return

    const [order] = await db
      .select({ totalCents: orders.totalCents, currency: orders.currency })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1)

    if (!order) return

    const [contact] = await db
      .select({ firstName: contacts.firstName })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1)

    const rendered = orderReceipt({
      firstName: contact?.firstName ?? null,
      programTitle: line.programTitle,
      amountLabel: formatMoney(order.totalCents, order.currency),
      // No separate receipt number in the schema, and inventing a counter
      // would be a second source of truth for the same fact. The order's own
      // id, shortened, is unique and is what support would look her up by.
      orderReference: orderId.slice(0, 8).toUpperCase(),
      refundWindowDays: line.refundWindowDays,
      siteUrl: site,
    })

    await sendToContact({
      db,
      contactId,
      rendered,
      kind: 'transactional',
      templateSlug: 'order-receipt',
      idempotencyKey: `order-receipt:${orderId}`,
    })
  } catch (error) {
    console.error('[fulfilment] receipt email failed', { orderId, error })
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
  /*
   * Where the links in her receipt point.
   *
   * Passed in rather than read here, because the correct answer depends on
   * the caller: the webhook route resolves it from the request headers, which
   * is the only source that survives NEXT_PUBLIC_SITE_URL having been wrong
   * at build time. The env fallback keeps the admin action and the
   * verification scripts working unchanged.
   */
  site: string = configuredSiteUrl(),
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
      await moveToStage(db, order.contactId, 'enrolled')
      await sendReceipt(db, order.id, order.contactId, site)

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

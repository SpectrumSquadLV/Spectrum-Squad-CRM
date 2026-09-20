'use server'

import { desc, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db/client'
import {
  auditLog,
  coupons,
  offers,
  orders,
  payments,
  refunds,
} from '@/db/schema'
import { getActor } from '@/lib/auth/actor-server'
import { isAdmin, type Actor } from '@/lib/permissions/actor'
import { paymentProvider } from '@/lib/payments'
import { checkRefund, statusAfterRefund } from '@/features/commerce/pricing'

export type CommerceState = { ok?: boolean; error?: string }

async function requireAdmin(): Promise<Actor | null> {
  const actor = await getActor()
  return isAdmin(actor) ? actor : null
}

async function audit(
  actor: Actor,
  action: string,
  entity: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await db.insert(auditLog).values({
    actorUserId: actor.kind === 'user' ? actor.userId : null,
    action,
    entity,
    entityId,
    metadata,
  })
}

const offerSchema = z.object({
  programId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name it.').max(160),
  pricingType: z.enum(['free', 'one_time', 'payment_plan', 'subscription']),
  priceDollars: z.coerce.number().min(0).max(1_000_000),
  installments: z.coerce.number().int().min(1).max(36).optional(),
  installmentIntervalDays: z.coerce.number().int().min(1).max(365).optional(),
  refundWindowDays: z.coerce.number().int().min(0).max(365),
  status: z.enum(['draft', 'active', 'archived']),
})

/**
 * Create or update an offer.
 *
 * Prices are entered in dollars and stored in CENTS. The conversion happens
 * here, once, so no other code has to remember which unit it is holding.
 */
export async function saveOffer(
  offerId: string | null,
  _prev: CommerceState,
  formData: FormData,
): Promise<CommerceState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access.' }

  const parsed = offerSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }
  const input = parsed.data

  // Round, never truncate: 37.5 dollars must become 3750 cents, not 3749.
  const priceCents = Math.round(input.priceDollars * 100)

  const values = {
    programId: input.programId,
    name: input.name,
    pricingType: input.pricingType,
    priceCents,
    refundWindowDays: input.refundWindowDays,
    status: input.status,
    installments:
      input.pricingType === 'payment_plan' ? (input.installments ?? 3) : null,
    installmentIntervalDays:
      input.pricingType === 'payment_plan'
        ? (input.installmentIntervalDays ?? 30)
        : null,
    updatedAt: new Date(),
  }

  if (offerId) {
    await db.update(offers).set(values).where(eq(offers.id, offerId))
    await audit(actor, 'offer.updated', 'offers', offerId, { priceCents })
  } else {
    const [created] = await db.insert(offers).values(values).returning()
    await audit(actor, 'offer.created', 'offers', created?.id ?? null, { priceCents })
  }

  revalidatePath('/admin/offers')
  return { ok: true }
}

const couponSchema = z.object({
  code: z.string().trim().min(2, 'Give it a code.').max(64),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: z.coerce.number().min(0),
  offerId: z.string().optional(),
  maxRedemptions: z.coerce.number().int().min(0).optional(),
  expiresAt: z.string().optional(),
})

export async function createCoupon(
  _prev: CommerceState,
  formData: FormData,
): Promise<CommerceState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access.' }

  const parsed = couponSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }
  const input = parsed.data

  // A percentage is a whole number; a fixed discount is dollars -> cents.
  const discountValue =
    input.discountType === 'percent'
      ? Math.min(100, Math.round(input.discountValue))
      : Math.round(input.discountValue * 100)

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return { error: 'That expiry date did not parse.' }
  }

  const [created] = await db
    .insert(coupons)
    .values({
      code: input.code.toUpperCase(),
      discountType: input.discountType,
      discountValue,
      offerId: input.offerId || null,
      maxRedemptions: input.maxRedemptions ? input.maxRedemptions : null,
      expiresAt,
      isActive: true,
    })
    .onConflictDoNothing({ target: coupons.code })
    .returning()

  if (!created) return { error: 'That code already exists.' }

  await audit(actor, 'coupon.created', 'coupons', created.id, { code: created.code })
  revalidatePath('/admin/offers')
  return { ok: true }
}

export async function setCouponActive(
  couponId: string,
  isActive: boolean,
): Promise<CommerceState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access.' }

  await db
    .update(coupons)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(coupons.id, couponId))

  await audit(actor, 'coupon.toggled', 'coupons', couponId, { isActive })
  revalidatePath('/admin/offers')
  return { ok: true }
}

/**
 * Refund an order.
 *
 * The refund window is enforced HERE as well as in the UI, because the UI is
 * only a suggestion. The provider is called first: if the money does not move,
 * nothing is recorded, so the books never claim a refund that did not happen.
 */
export async function refundOrder(
  orderId: string,
  _prev: CommerceState,
  formData: FormData,
): Promise<CommerceState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access.' }

  const reason = String(formData.get('reason') ?? '').trim() || undefined
  const override = formData.get('override') === 'on'

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) return { error: 'That order does not exist.' }

  const [refundedAgg] = await db
    .select({ total: sql<number>`coalesce(sum(${refunds.amountCents}), 0)` })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(eq(payments.orderId, orderId))

  const refundedCents = Number(refundedAgg?.total ?? 0)

  const [offerRow] = await db
    .select({ refundWindowDays: offers.refundWindowDays })
    .from(offers)
    .where(
      sql`${offers.id} = (SELECT offer_id FROM order_items WHERE order_id = ${orderId} LIMIT 1)`,
    )
    .limit(1)

  const windowDays = offerRow?.refundWindowDays ?? 14

  const check = checkRefund(
    {
      status: order.status,
      paidAt: order.paidAt,
      totalCents: order.totalCents,
      refundedCents,
    },
    windowDays,
    new Date(),
  )

  if (!check.allowed) {
    // Outside the window an owner may still choose to refund - but it has to
    // be a deliberate act, and it is audited as one.
    if (!(override && check.reason === 'window_closed')) {
      return {
        error:
          check.reason === 'window_closed'
            ? `The ${windowDays}-day window closed on ${check.windowClosesAt?.toLocaleDateString('en-US')}. Tick the override to refund anyway.`
            : check.reason === 'already_refunded'
              ? 'That order has already been refunded in full.'
              : 'That order cannot be refunded.',
      }
    }
  }

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.processedAt))
    .limit(1)

  const amountCents = check.refundableCents
  if (amountCents <= 0) return { error: 'There is nothing left to refund.' }

  // Free orders never reached the provider, so there is nothing to send back.
  if (payment?.stripePaymentIntentId) {
    try {
      const result = await paymentProvider().refund({
        paymentIntentId: payment.stripePaymentIntentId,
        amountCents,
        reason,
      })

      await db.insert(refunds).values({
        paymentId: payment.id,
        amountCents: result.amountCents,
        reason: reason ?? null,
        issuedBy: actor.kind === 'user' ? actor.userId : null,
        stripeRefundId: result.refundId,
      })
    } catch {
      return { error: 'The payment provider refused the refund. Nothing changed.' }
    }
  } else if (payment) {
    await db.insert(refunds).values({
      paymentId: payment.id,
      amountCents,
      reason: reason ?? null,
      issuedBy: actor.kind === 'user' ? actor.userId : null,
    })
  }

  await db
    .update(orders)
    .set({
      status: statusAfterRefund(order.totalCents, refundedCents, amountCents),
      updatedAt: new Date(),
    })
    .where(eq(orders.id, orderId))

  await audit(actor, 'order.refunded', 'orders', orderId, {
    amountCents,
    reason: reason ?? null,
    outsideWindow: !check.allowed,
  })

  revalidatePath('/admin/orders')
  revalidatePath(`/admin/contacts/${order.contactId}`)
  return { ok: true }
}

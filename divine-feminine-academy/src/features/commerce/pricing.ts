/**
 * Pricing, coupons, instalments and refunds.
 *
 * Pure functions with no database and no clock of their own. Everything here
 * deals in integer CENTS - never floats. `0.1 + 0.2` is not `0.3`, and a
 * rounding error in this file is a woman charged the wrong amount.
 */

export type DiscountType = 'percent' | 'fixed'
export type PricingType = 'free' | 'one_time' | 'payment_plan' | 'subscription'

export interface Offer {
  id: string
  pricingType: PricingType
  /** For a payment plan this is the price of ONE instalment. */
  priceCents: number
  currency: string
  installments: number | null
  installmentIntervalDays: number | null
  refundWindowDays: number
}

export interface Coupon {
  id: string
  code: string
  discountType: DiscountType
  /** Percent as a whole number (20 = 20%), or an amount in cents. */
  discountValue: number
  offerId: string | null
  maxRedemptions: number | null
  redemptionCount: number
  startsAt: Date | null
  expiresAt: Date | null
  isActive: boolean
}

/** What an offer costs in total, before any discount. */
export function offerTotalCents(offer: Offer): number {
  if (offer.pricingType === 'free') return 0
  if (offer.pricingType === 'payment_plan') {
    const n = offer.installments ?? 1
    return offer.priceCents * Math.max(1, n)
  }
  return offer.priceCents
}

export type CouponRejection =
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'exhausted'
  | 'wrong_offer'
  | 'free_offer'

export interface CouponCheck {
  valid: boolean
  reason?: CouponRejection
}

export function checkCoupon(
  coupon: Coupon,
  offer: Offer,
  now: Date,
): CouponCheck {
  if (!coupon.isActive) return { valid: false, reason: 'inactive' }
  if (coupon.startsAt && now < coupon.startsAt) {
    return { valid: false, reason: 'not_started' }
  }
  // Expiry is exclusive: a coupon expiring at midnight is dead at midnight.
  if (coupon.expiresAt && now >= coupon.expiresAt) {
    return { valid: false, reason: 'expired' }
  }
  if (
    coupon.maxRedemptions !== null &&
    coupon.redemptionCount >= coupon.maxRedemptions
  ) {
    return { valid: false, reason: 'exhausted' }
  }
  // A null offerId means it applies everywhere.
  if (coupon.offerId !== null && coupon.offerId !== offer.id) {
    return { valid: false, reason: 'wrong_offer' }
  }
  if (offer.pricingType === 'free') return { valid: false, reason: 'free_offer' }

  return { valid: true }
}

/**
 * Discount in cents, never more than the subtotal.
 *
 * A percentage rounds DOWN, so a rounding error can never charge her more
 * than the arithmetic says.
 */
export function discountCents(coupon: Coupon, subtotalCents: number): number {
  if (subtotalCents <= 0) return 0

  const raw =
    coupon.discountType === 'percent'
      ? Math.floor((subtotalCents * clampPercent(coupon.discountValue)) / 100)
      : Math.max(0, Math.round(coupon.discountValue))

  return Math.min(raw, subtotalCents)
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export interface OrderTotals {
  subtotalCents: number
  discountCents: number
  totalCents: number
  currency: string
}

export function priceOrder(
  offer: Offer,
  coupon: Coupon | null,
  now: Date,
): OrderTotals & { couponApplied: boolean; couponReason?: CouponRejection } {
  const subtotalCents = offerTotalCents(offer)

  if (!coupon) {
    return {
      subtotalCents,
      discountCents: 0,
      totalCents: subtotalCents,
      currency: offer.currency,
      couponApplied: false,
    }
  }

  const check = checkCoupon(coupon, offer, now)
  if (!check.valid) {
    return {
      subtotalCents,
      discountCents: 0,
      totalCents: subtotalCents,
      currency: offer.currency,
      couponApplied: false,
      couponReason: check.reason,
    }
  }

  const discount = discountCents(coupon, subtotalCents)
  return {
    subtotalCents,
    discountCents: discount,
    totalCents: subtotalCents - discount,
    currency: offer.currency,
    couponApplied: true,
  }
}

export interface Installment {
  number: number
  amountCents: number
  dueAt: Date
}

/**
 * The instalment schedule for a payment plan.
 *
 * The total is divided evenly and any remainder goes on the FIRST payment, so
 * the instalments always add back up to exactly the total. Putting the
 * remainder last would mean a final payment that is a few cents larger than
 * the one she agreed to, which is the kind of thing that generates a dispute.
 */
export function installmentSchedule(
  offer: Offer,
  totalCents: number,
  startAt: Date,
): Installment[] {
  if (offer.pricingType !== 'payment_plan') {
    return [{ number: 1, amountCents: totalCents, dueAt: startAt }]
  }

  const count = Math.max(1, offer.installments ?? 1)
  const intervalDays = Math.max(1, offer.installmentIntervalDays ?? 30)

  const base = Math.floor(totalCents / count)
  const remainder = totalCents - base * count

  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    amountCents: i === 0 ? base + remainder : base,
    dueAt: new Date(startAt.getTime() + i * intervalDays * 86_400_000),
  }))
}

export type RefundRejection = 'not_paid' | 'window_closed' | 'already_refunded'

export interface RefundCheck {
  allowed: boolean
  reason?: RefundRejection
  /** What could be refunded, in cents. */
  refundableCents: number
  windowClosesAt: Date | null
}

/**
 * Whether a refund is still within the window.
 *
 * Measured from when she PAID, not when she ordered: a payment plan's window
 * should not start running before any money moved.
 */
export function checkRefund(
  {
    status,
    paidAt,
    totalCents,
    refundedCents,
  }: {
    status: string
    paidAt: Date | null
    totalCents: number
    refundedCents: number
  },
  refundWindowDays: number,
  now: Date,
): RefundCheck {
  const refundableCents = Math.max(0, totalCents - refundedCents)

  if (status !== 'paid' && status !== 'partially_refunded') {
    return { allowed: false, reason: 'not_paid', refundableCents: 0, windowClosesAt: null }
  }
  if (refundableCents === 0) {
    return {
      allowed: false,
      reason: 'already_refunded',
      refundableCents: 0,
      windowClosesAt: null,
    }
  }
  if (!paidAt) {
    return { allowed: false, reason: 'not_paid', refundableCents, windowClosesAt: null }
  }

  const windowClosesAt = new Date(
    paidAt.getTime() + refundWindowDays * 86_400_000,
  )

  if (now > windowClosesAt) {
    return { allowed: false, reason: 'window_closed', refundableCents, windowClosesAt }
  }

  return { allowed: true, refundableCents, windowClosesAt }
}

/** Where an order lands after a refund of `amountCents`. */
export function statusAfterRefund(
  totalCents: number,
  refundedCents: number,
  amountCents: number,
): 'refunded' | 'partially_refunded' {
  return refundedCents + amountCents >= totalCents
    ? 'refunded'
    : 'partially_refunded'
}

/** Money for people, not for machines: 129900 -> "$1,299.00". */
export function formatMoney(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100)
}

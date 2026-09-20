/**
 * Pricing, coupons, instalments and refunds.
 *
 * A bug in this file charges a real woman the wrong amount, so the awkward
 * cases get tested rather than assumed: a 100% coupon, a discount larger than
 * the price, a total that does not divide evenly, and a refund window measured
 * from the wrong date.
 *
 * Run: npm run verify:pricing
 */
import assert from 'node:assert/strict'
import {
  checkCoupon,
  checkRefund,
  discountCents,
  formatMoney,
  installmentSchedule,
  offerTotalCents,
  priceOrder,
  statusAfterRefund,
  type Coupon,
  type Offer,
} from '../src/features/commerce/pricing'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok   ${name}`)
}

const NOW = new Date('2026-06-15T12:00:00Z')

const academy: Offer = {
  id: 'offer-academy',
  pricingType: 'one_time',
  priceCents: 100_000, // $1,000
  currency: 'usd',
  installments: null,
  installmentIntervalDays: null,
  refundWindowDays: 14,
}

const plan: Offer = {
  id: 'offer-plan',
  pricingType: 'payment_plan',
  priceCents: 37_500, // $375 per instalment
  currency: 'usd',
  installments: 3,
  installmentIntervalDays: 30,
  refundWindowDays: 14,
}

const freeOffer: Offer = { ...academy, id: 'offer-free', pricingType: 'free', priceCents: 0 }

const coupon = (over: Partial<Coupon> = {}): Coupon => ({
  id: 'c1',
  code: 'HER20',
  discountType: 'percent',
  discountValue: 20,
  offerId: null,
  maxRedemptions: null,
  redemptionCount: 0,
  startsAt: null,
  expiresAt: null,
  isActive: true,
  ...over,
})

console.log('what an offer costs:')

check('a one-time offer costs its price', () => {
  assert.equal(offerTotalCents(academy), 100_000)
})

check('a payment plan costs the instalment times the count', () => {
  assert.equal(offerTotalCents(plan), 112_500, '3 x $375 should be $1,125')
})

check('a free offer costs nothing', () => {
  assert.equal(offerTotalCents(freeOffer), 0)
})

console.log('\ncoupons:')

check('a percentage discount rounds DOWN, never up', () => {
  // 33% of $9.99 is 329.67 cents.
  assert.equal(discountCents(coupon({ discountValue: 33 }), 999), 329)
})

check('a fixed discount is taken in cents', () => {
  assert.equal(
    discountCents(coupon({ discountType: 'fixed', discountValue: 25_000 }), 100_000),
    25_000,
  )
})

check('a discount can never exceed the price', () => {
  assert.equal(
    discountCents(coupon({ discountType: 'fixed', discountValue: 500_000 }), 100_000),
    100_000,
    'she must never be owed money by a coupon',
  )
})

check('a 100% coupon makes it free, not negative', () => {
  const result = priceOrder(academy, coupon({ discountValue: 100 }), NOW)
  assert.equal(result.totalCents, 0)
  assert.equal(result.discountCents, 100_000)
})

check('a nonsense percentage is clamped', () => {
  assert.equal(discountCents(coupon({ discountValue: 500 }), 100_000), 100_000)
  assert.equal(discountCents(coupon({ discountValue: -20 }), 100_000), 0)
})

check('an inactive coupon is refused', () => {
  const c = checkCoupon(coupon({ isActive: false }), academy, NOW)
  assert.equal(c.valid, false)
  assert.equal(c.reason, 'inactive')
})

check('a coupon that has not started is refused', () => {
  const c = checkCoupon(
    coupon({ startsAt: new Date('2026-07-01T00:00:00Z') }),
    academy,
    NOW,
  )
  assert.equal(c.reason, 'not_started')
})

check('an expired coupon is refused, and expiry is exclusive', () => {
  assert.equal(
    checkCoupon(coupon({ expiresAt: new Date('2026-06-01T00:00:00Z') }), academy, NOW)
      .reason,
    'expired',
  )
  // Dead exactly at its expiry instant.
  assert.equal(checkCoupon(coupon({ expiresAt: NOW }), academy, NOW).reason, 'expired')
  assert.equal(
    checkCoupon(coupon({ expiresAt: new Date(NOW.getTime() + 1000) }), academy, NOW)
      .valid,
    true,
  )
})

check('a coupon that has run out is refused', () => {
  assert.equal(
    checkCoupon(coupon({ maxRedemptions: 10, redemptionCount: 10 }), academy, NOW)
      .reason,
    'exhausted',
  )
  assert.equal(
    checkCoupon(coupon({ maxRedemptions: 10, redemptionCount: 9 }), academy, NOW).valid,
    true,
  )
})

check('a coupon scoped to another offer is refused', () => {
  assert.equal(
    checkCoupon(coupon({ offerId: 'offer-other' }), academy, NOW).reason,
    'wrong_offer',
  )
  assert.equal(checkCoupon(coupon({ offerId: academy.id }), academy, NOW).valid, true)
})

check('a coupon on a free offer is refused', () => {
  assert.equal(checkCoupon(coupon(), freeOffer, NOW).reason, 'free_offer')
})

check('a rejected coupon leaves the price alone and says why', () => {
  const result = priceOrder(academy, coupon({ isActive: false }), NOW)
  assert.equal(result.totalCents, 100_000)
  assert.equal(result.couponApplied, false)
  assert.equal(result.couponReason, 'inactive')
})

console.log('\ninstalments:')

check('a plan splits evenly when it divides', () => {
  const schedule = installmentSchedule(plan, 112_500, NOW)
  assert.equal(schedule.length, 3)
  assert.deepEqual(
    schedule.map((i) => i.amountCents),
    [37_500, 37_500, 37_500],
  )
})

check('instalments always add back up to the total', () => {
  for (const total of [100_000, 99_999, 100_001, 1, 7, 112_501]) {
    for (const count of [1, 2, 3, 4, 6, 12]) {
      const schedule = installmentSchedule(
        { ...plan, installments: count },
        total,
        NOW,
      )
      const sum = schedule.reduce((a, i) => a + i.amountCents, 0)
      assert.equal(sum, total, `${count} instalments of ${total} summed to ${sum}`)
    }
  }
})

check('the remainder goes on the FIRST payment, not the last', () => {
  // $1,000 over 3 is 33333.33; the extra cent must not land on the final one.
  const schedule = installmentSchedule({ ...plan, installments: 3 }, 100_000, NOW)
  assert.deepEqual(
    schedule.map((i) => i.amountCents),
    [33_334, 33_333, 33_333],
  )
})

check('instalments are spaced by the configured interval', () => {
  const schedule = installmentSchedule(plan, 112_500, NOW)
  assert.equal(schedule[0]!.dueAt.getTime(), NOW.getTime())
  assert.equal(
    schedule[1]!.dueAt.getTime() - schedule[0]!.dueAt.getTime(),
    30 * 86_400_000,
  )
})

check('a one-time offer is a single payment', () => {
  const schedule = installmentSchedule(academy, 100_000, NOW)
  assert.equal(schedule.length, 1)
  assert.equal(schedule[0]!.amountCents, 100_000)
})

console.log('\nrefunds:')

const paidAt = new Date('2026-06-10T12:00:00Z')

check('inside the window a refund is allowed', () => {
  const r = checkRefund(
    { status: 'paid', paidAt, totalCents: 100_000, refundedCents: 0 },
    14,
    NOW,
  )
  assert.equal(r.allowed, true)
  assert.equal(r.refundableCents, 100_000)
})

check('outside the window it is refused', () => {
  const r = checkRefund(
    { status: 'paid', paidAt, totalCents: 100_000, refundedCents: 0 },
    14,
    new Date('2026-07-01T12:00:00Z'),
  )
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'window_closed')
})

check('the window runs from when she PAID, not when she ordered', () => {
  const r = checkRefund(
    { status: 'paid', paidAt, totalCents: 100_000, refundedCents: 0 },
    14,
    NOW,
  )
  assert.equal(r.windowClosesAt?.toISOString(), '2026-06-24T12:00:00.000Z')
})

check('an unpaid order cannot be refunded', () => {
  assert.equal(
    checkRefund(
      { status: 'pending', paidAt: null, totalCents: 100_000, refundedCents: 0 },
      14,
      NOW,
    ).reason,
    'not_paid',
  )
})

check('a fully refunded order cannot be refunded again', () => {
  assert.equal(
    checkRefund(
      { status: 'refunded', paidAt, totalCents: 100_000, refundedCents: 100_000 },
      14,
      NOW,
    ).reason,
    'not_paid',
  )
})

check('a partly refunded order can be refunded the rest', () => {
  const r = checkRefund(
    { status: 'partially_refunded', paidAt, totalCents: 100_000, refundedCents: 40_000 },
    14,
    NOW,
  )
  assert.equal(r.allowed, true)
  assert.equal(r.refundableCents, 60_000)
})

check('the status after a refund reflects how much is left', () => {
  assert.equal(statusAfterRefund(100_000, 0, 40_000), 'partially_refunded')
  assert.equal(statusAfterRefund(100_000, 40_000, 60_000), 'refunded')
  assert.equal(statusAfterRefund(100_000, 0, 100_000), 'refunded')
})

console.log('\nformatting:')

check('money reads the way a person would say it', () => {
  assert.equal(formatMoney(100_000), '$1,000.00')
  assert.equal(formatMoney(37_500), '$375.00')
  assert.equal(formatMoney(0), '$0.00')
})

console.log(`\npricing: all ${passed} checks passed`)

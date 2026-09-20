/**
 * What happens after she pays, against a real database.
 *
 * The claim being tested is idempotency. Payment providers retry webhooks and
 * deliver them out of order; handling one twice must not enrol her twice,
 * double her lifetime value, or count a coupon redemption again.
 *
 * Run: DATABASE_URL=... npm run verify:fulfilment
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

process.env.JOURNAL_MASTER_KEY ??= randomBytes(32).toString('base64')

const { db } = await import('../src/db/client')
const { contacts } = await import('../src/db/schema/identity')
const { programs } = await import('../src/db/schema/programs')
const { enrollments } = await import('../src/db/schema/progress')
const { coupons, offers, orderItems, orders, payments } = await import(
  '../src/db/schema/commerce'
)
const { activityEvents } = await import('../src/db/schema/activity')
const { handlePaymentEvent } = await import('../src/features/commerce/fulfilment')
const { createFakeProvider } = await import('../src/lib/payments/fake')

function must<T>(v: T | null | undefined, m: string): T {
  if (!v) throw new Error(m)
  return v
}

let passed = 0
async function check(name: string, fn: () => void | Promise<void>) {
  await fn()
  passed++
  console.log(`  ok   ${name}`)
}

const program = must(
  (await db.select().from(programs).where(eq(programs.slug, '7-days-to-her')).limit(1))[0],
  'run `npm run seed:challenge` first',
)

const cleanup: string[] = []

async function scenario(opts: { withCoupon?: boolean } = {}) {
  const contact = must(
    (
      await db
        .insert(contacts)
        .values({ email: `pay-${randomUUID()}@example.test`, firstName: 'Buyer' })
        .returning()
    )[0],
    'no contact',
  )
  cleanup.push(contact.id)

  const offer = must(
    (
      await db
        .insert(offers)
        .values({
          programId: program.id,
          name: 'Test offer',
          pricingType: 'one_time',
          priceCents: 100_000,
          status: 'active',
        })
        .returning()
    )[0],
    'no offer',
  )

  let couponId: string | null = null
  if (opts.withCoupon) {
    const coupon = must(
      (
        await db
          .insert(coupons)
          .values({
            code: `TEST${randomUUID().slice(0, 8).toUpperCase()}`,
            discountType: 'percent',
            discountValue: 20,
            maxRedemptions: 5,
          })
          .returning()
      )[0],
      'no coupon',
    )
    couponId = coupon.id
  }

  const order = must(
    (
      await db
        .insert(orders)
        .values({
          contactId: contact.id,
          status: 'pending',
          subtotalCents: 100_000,
          discountCents: couponId ? 20_000 : 0,
          totalCents: couponId ? 80_000 : 100_000,
          couponId,
        })
        .returning()
    )[0],
    'no order',
  )

  await db.insert(orderItems).values({
    orderId: order.id,
    offerId: offer.id,
    quantity: 1,
    unitPriceCents: order.totalCents,
  })

  return { contact, offer, order, couponId }
}

const paidEvent = (orderId: string, id: string) => ({
  id,
  type: 'checkout.completed' as const,
  orderId,
  sessionId: 'cs_test',
  paymentIntentId: `pi_${id}`,
  customerId: 'cus_test',
  amountCents: 100_000,
  currency: 'usd',
  failureReason: null,
  metadata: { orderId },
  raw: null,
})

console.log('a successful payment:')

const s1 = await scenario()

await check('marks the order paid and records the payment', async () => {
  const result = await handlePaymentEvent(db, paidEvent(s1.order.id, `evt_${randomUUID()}`))
  assert.equal(result.handled, true)

  const [order] = await db.select().from(orders).where(eq(orders.id, s1.order.id))
  assert.equal(order!.status, 'paid')
  assert.ok(order!.paidAt)

  const rows = await db.select().from(payments).where(eq(payments.orderId, s1.order.id))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'succeeded')
})

await check('grants the enrollment she paid for', async () => {
  const rows = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.contactId, s1.contact.id))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.programId, program.id)
})

await check('adds to her lifetime value', async () => {
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, s1.contact.id))
  assert.equal(contact!.lifetimeValueCents, 100_000)
})

await check('moves her along the pipeline', async () => {
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, s1.contact.id))
  assert.ok(contact!.crmStageId, 'she should have been moved to a stage')
})

console.log('\nthe same webhook delivered twice:')

await check('the duplicate is refused', async () => {
  const event = paidEvent(s1.order.id, `evt_${randomUUID()}`)
  await handlePaymentEvent(db, event)
  const again = await handlePaymentEvent(db, event)
  assert.equal(again.handled, false)
  assert.equal(again.reason, 'duplicate')
})

await check('she is NOT enrolled twice', async () => {
  const rows = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.contactId, s1.contact.id))
  assert.equal(rows.length, 1, 'a replayed webhook created a second enrollment')
})

await check('a DIFFERENT event id for the same order still does not duplicate access', async () => {
  // Providers legitimately send checkout.completed and payment_intent.succeeded
  // for one purchase. Both are handled; neither may grant twice.
  await handlePaymentEvent(db, {
    ...paidEvent(s1.order.id, `evt_${randomUUID()}`),
    type: 'payment.succeeded',
  })
  const rows = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.contactId, s1.contact.id))
  assert.equal(rows.length, 1, 'a second event granted a second enrollment')
})

console.log('\ncoupons:')

const s2 = await scenario({ withCoupon: true })

await check('a redemption is recorded and counted once', async () => {
  const event = paidEvent(s2.order.id, `evt_${randomUUID()}`)
  await handlePaymentEvent(db, event)
  await handlePaymentEvent(db, event)

  const [coupon] = await db
    .select()
    .from(coupons)
    .where(eq(coupons.id, s2.couponId!))
  assert.equal(coupon!.redemptionCount, 1, 'a replay double-counted the coupon')
})

console.log('\nfailures and strangers:')

const s3 = await scenario()

await check('a failed payment marks the order failed and grants nothing', async () => {
  await handlePaymentEvent(db, {
    ...paidEvent(s3.order.id, `evt_${randomUUID()}`),
    type: 'payment.failed',
    failureReason: 'card_declined',
  })

  const [order] = await db.select().from(orders).where(eq(orders.id, s3.order.id))
  assert.equal(order!.status, 'failed')

  const rows = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.contactId, s3.contact.id))
  assert.equal(rows.length, 0, 'a failed payment granted access')
})

await check('an event for an unknown order is ignored safely', async () => {
  const result = await handlePaymentEvent(db, {
    ...paidEvent(randomUUID(), `evt_${randomUUID()}`),
  })
  assert.equal(result.handled, false)
  assert.equal(result.reason, 'no-order')
})

await check('an event with no order id is ignored safely', async () => {
  const result = await handlePaymentEvent(db, {
    ...paidEvent(s1.order.id, `evt_${randomUUID()}`),
    orderId: null,
    metadata: {},
  })
  assert.equal(result.handled, false)
  assert.equal(result.reason, 'no-order')
})

await check('an event type we do not handle is ignored, not crashed on', async () => {
  const result = await handlePaymentEvent(db, {
    ...paidEvent(s1.order.id, `evt_${randomUUID()}`),
    type: 'unknown',
  })
  assert.equal(result.handled, false)
  assert.equal(result.reason, 'unknown-event')
})

console.log('\nthe webhook endpoint contract:')

await check('a forged signature never reaches fulfilment', async () => {
  const fake = createFakeProvider('whsec_test')
  const { body } = fake.sign(paidEvent(s1.order.id, `evt_${randomUUID()}`))
  await assert.rejects(
    () => fake.provider.parseWebhook(body, 't=1,v1=forged'),
    'a forged webhook parsed successfully',
  )
})

await check('every handled event is recorded for the audit trail', async () => {
  const rows = await db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.contactId, s1.contact.id))
  assert.ok(
    rows.some((r) => r.eventType === 'payment.webhook'),
    'no webhook was recorded',
  )
  assert.ok(
    rows.some((r) => r.eventType === 'enrollment.granted'),
    'no enrollment grant was recorded',
  )
})

// -------------------------------------------------------------- teardown ---
//
// Orders deliberately do NOT cascade from contacts: they are financial
// records, and a contact is archived rather than deleted in production (see
// `contacts.archivedAt`). So the test cleans up in dependency order.
const createdOffers = new Set<string>()

for (const id of cleanup) {
  const rows = await db.select({ id: orders.id }).from(orders).where(eq(orders.contactId, id))
  for (const order of rows) {
    const items = await db
      .select({ offerId: orderItems.offerId })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
    for (const item of items) createdOffers.add(item.offerId)

    await db.delete(payments).where(eq(payments.orderId, order.id))
    await db.delete(orderItems).where(eq(orderItems.orderId, order.id))
    await db.delete(orders).where(eq(orders.id, order.id))
  }
  await db.delete(contacts).where(eq(contacts.id, id))
}

// The test offers are created ACTIVE, which makes them purchasable. Leaving
// them behind would mean a preflight against this database reports a dozen
// live offers that nobody meant to sell.
for (const offerId of createdOffers) {
  await db.delete(offers).where(eq(offers.id, offerId))
}

console.log(`\nfulfilment: all ${passed} checks passed`)
process.exit(0)

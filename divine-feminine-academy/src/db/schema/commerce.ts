import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryId, timestamps } from './_shared'
import { contacts } from './identity'
import { programs } from './programs'

export const pricingTypeEnum = pgEnum('pricing_type', [
  'free',
  'one_time',
  'payment_plan',
  'subscription',
])

export const offerStatusEnum = pgEnum('offer_status', [
  'draft',
  'active',
  'archived',
])

/** Pricing is never hard-coded. The $1,000 Academy is a row here. */
export const offers = pgTable(
  'offers',
  {
    id: primaryId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    pricingType: pricingTypeEnum('pricing_type').notNull(),
    priceCents: integer('price_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    /** For payment plans: how many instalments of priceCents. */
    installments: integer('installments'),
    installmentIntervalDays: integer('installment_interval_days'),
    stripePriceId: text('stripe_price_id'),
    refundWindowDays: integer('refund_window_days').notNull().default(14),
    status: offerStatusEnum('status').notNull().default('draft'),
    ...timestamps,
  },
  (t) => [index('offers_program_idx').on(t.programId, t.status)],
)

export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'paid',
  'failed',
  'refunded',
  'partially_refunded',
  'cancelled',
])

export const orders = pgTable(
  'orders',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    status: orderStatusEnum('status').notNull().default('pending'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    discountCents: integer('discount_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    couponId: uuid('coupon_id'),
    /**
     * Which live run she bought a seat in, if any.
     *
     * Explicit rather than inferred from the offer. Two cohorts can share one
     * offer, and guessing would put a woman in the wrong room on the one
     * occasion it matters most.
     */
    cohortId: uuid('cohort_id'),
    stripeCheckoutSessionId: text('stripe_checkout_session_id'),
    stripeCustomerId: text('stripe_customer_id'),
    placedAt: timestamp('placed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('orders_contact_idx').on(t.contactId),
    uniqueIndex('orders_checkout_session_key').on(t.stripeCheckoutSessionId),
  ],
)

export const orderItems = pgTable(
  'order_items',
  {
    id: primaryId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id),
    quantity: integer('quantity').notNull().default(1),
    unitPriceCents: integer('unit_price_cents').notNull(),
    ...timestamps,
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
)

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'succeeded',
  'failed',
])

export const payments = pgTable(
  'payments',
  {
    id: primaryId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    status: paymentStatusEnum('status').notNull().default('pending'),
    /** Which instalment this is, for payment plans. */
    installmentNumber: integer('installment_number'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    failureReason: text('failure_reason'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('payments_order_idx').on(t.orderId),
    uniqueIndex('payments_intent_key').on(t.stripePaymentIntentId),
  ],
)

export const refunds = pgTable(
  'refunds',
  {
    id: primaryId(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    amountCents: integer('amount_cents').notNull(),
    reason: text('reason'),
    issuedBy: uuid('issued_by'),
    stripeRefundId: text('stripe_refund_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [index('refunds_payment_idx').on(t.paymentId)],
)

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'cancelled',
  'paused',
])

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('subscriptions_contact_idx').on(t.contactId),
    uniqueIndex('subscriptions_stripe_key').on(t.stripeSubscriptionId),
  ],
)

export const discountTypeEnum = pgEnum('discount_type', ['percent', 'fixed'])

export const coupons = pgTable(
  'coupons',
  {
    id: primaryId(),
    code: text('code').notNull(),
    discountType: discountTypeEnum('discount_type').notNull(),
    discountValue: integer('discount_value').notNull(),
    /** Null means it applies to every offer. */
    offerId: uuid('offer_id').references(() => offers.id),
    maxRedemptions: integer('max_redemptions'),
    redemptionCount: integer('redemption_count').notNull().default(0),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('coupons_code_key').on(t.code)],
)

export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: primaryId(),
    couponId: uuid('coupon_id')
      .notNull()
      .references(() => coupons.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    amountCents: integer('amount_cents').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex('coupon_redemptions_key').on(t.couponId, t.orderId)],
)

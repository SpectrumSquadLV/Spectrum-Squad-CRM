import Link from 'next/link'
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts, orders, payments, refunds } from '@/db/schema'
import { Badge } from '@/design-system/primitives'
import { RefundForm } from '@/features/admin/OfferForms'
import { formatMoney } from '@/features/commerce/pricing'

export const metadata = { title: 'Orders' }

export default async function OrdersPage() {
  const rows = await db
    .select({
      order: orders,
      email: contacts.email,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      refundedCents: sql<number>`(
        SELECT coalesce(sum(${refunds.amountCents}), 0)
        FROM ${refunds}
        JOIN ${payments} ON ${payments.id} = ${refunds.paymentId}
        WHERE ${payments.orderId} = ${orders.id}
      )`,
    })
    .from(orders)
    .innerJoin(contacts, eq(contacts.id, orders.contactId))
    .orderBy(desc(orders.placedAt))
    .limit(100)

  const paidTotal = rows
    .filter((r) => r.order.status === 'paid')
    .reduce((sum, r) => sum + r.order.totalCents, 0)

  const refundedTotal = rows.reduce((sum, r) => sum + Number(r.refundedCents), 0)

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <h1 className="text-lg font-semibold">Orders</h1>

      <dl className="mt-6 grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-3">
        <div className="bg-alabaster p-4">
          <dd className="font-display text-2xl leading-none">
            {formatMoney(paidTotal)}
          </dd>
          <dt className="mt-2 text-2xs text-ink-muted">Collected (last 100)</dt>
        </div>
        <div className="bg-alabaster p-4">
          <dd className="font-display text-2xl leading-none">
            {formatMoney(refundedTotal)}
          </dd>
          <dt className="mt-2 text-2xs text-ink-muted">Refunded</dt>
        </div>
        <div className="bg-alabaster p-4">
          <dd className="font-display text-2xl leading-none">{rows.length}</dd>
          <dt className="mt-2 text-2xs text-ink-muted">Orders</dt>
        </div>
      </dl>

      {rows.length === 0 ? (
        <p className="mt-10 text-2xs text-ink-muted">Nothing yet.</p>
      ) : (
        <table className="mt-8 w-full border-collapse text-2xs">
          <thead>
            <tr className="border-b border-rule-strong text-left text-ink-muted">
              <th className="py-2 pr-4 font-medium">Placed</th>
              <th className="py-2 pr-4 font-medium">Who</th>
              <th className="py-2 pr-4 font-medium">Total</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium"> </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ order, email, firstName, lastName, refundedCents }) => {
              const remaining = order.totalCents - Number(refundedCents)
              const refundable =
                (order.status === 'paid' || order.status === 'partially_refunded') &&
                remaining > 0

              return (
                <tr key={order.id} className="border-b border-rule align-top">
                  <td className="py-3 pr-4 text-ink-muted">
                    {order.placedAt.toLocaleDateString('en-US')}
                  </td>
                  <td className="py-3 pr-4">
                    <Link
                      href={`/admin/contacts/${order.contactId}`}
                      className="text-xs hover:text-clay-deep"
                    >
                      {[firstName, lastName].filter(Boolean).join(' ') || email}
                    </Link>
                  </td>
                  <td className="py-3 pr-4">
                    {formatMoney(order.totalCents, order.currency)}
                    {Number(refundedCents) > 0 && (
                      <span className="block text-ink-faint">
                        −{formatMoney(Number(refundedCents), order.currency)} refunded
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <Badge
                      className={
                        order.status === 'paid'
                          ? 'border-positive/40 text-positive'
                          : order.status === 'refunded' || order.status === 'failed'
                            ? 'border-critical/40 text-critical'
                            : undefined
                      }
                    >
                      {order.status}
                    </Badge>
                  </td>
                  <td className="py-3">
                    {refundable && (
                      <RefundForm
                        orderId={order.id}
                        refundable={formatMoney(remaining, order.currency)}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

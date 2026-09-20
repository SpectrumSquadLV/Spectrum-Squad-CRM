import { asc, desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { coupons, offers, programs } from '@/db/schema'
import { Rule } from '@/design-system/primitives'
import {
  CouponForm,
  CouponToggle,
  OfferForm,
  OfferStatusBadge,
} from '@/features/admin/OfferForms'
import { formatMoney, offerTotalCents } from '@/features/commerce/pricing'

export const metadata = { title: 'Offers' }

/**
 * Pricing lives here, as data.
 *
 * Nothing about what the Divine Feminine costs is written into the code: it is an
 * `offers` row, and changing it takes a form rather than a deploy.
 */
export default async function OffersPage() {
  const [offerRows, programRows, couponRows] = await Promise.all([
    db
      .select({ offer: offers, programTitle: programs.title })
      .from(offers)
      .innerJoin(programs, eq(programs.id, offers.programId))
      .orderBy(desc(offers.createdAt)),
    db.select({ id: programs.id, title: programs.title }).from(programs).orderBy(asc(programs.title)),
    db.select().from(coupons).orderBy(desc(coupons.createdAt)),
  ])

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <h1 className="text-lg font-semibold">Offers</h1>
      <p className="mt-2 max-w-xl text-2xs text-ink-muted">
        What a programme costs is a row here, not a line of code. A payment plan
        stores the price of ONE payment; the total is that times the count.
      </p>

      {programRows.length === 0 ? (
        <p className="mt-8 text-2xs text-ink-muted">
          Create a programme first — an offer has to sell something.
        </p>
      ) : (
        <>
          <section className="mt-8 border border-rule bg-alabaster p-4">
            <h2 className="text-2xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
              New offer
            </h2>
            <div className="mt-4">
              <OfferForm offerId={null} programs={programRows} />
            </div>
          </section>

          {offerRows.length > 0 && (
            <table className="mt-8 w-full border-collapse text-2xs">
              <thead>
                <tr className="border-b border-rule-strong text-left text-ink-muted">
                  <th className="py-2 pr-4 font-medium">Offer</th>
                  <th className="py-2 pr-4 font-medium">Program</th>
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Total</th>
                  <th className="py-2 pr-4 font-medium">Refund</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {offerRows.map(({ offer, programTitle }) => (
                  <tr key={offer.id} className="border-b border-rule">
                    <td className="py-3 pr-4 text-xs text-ink">{offer.name}</td>
                    <td className="py-3 pr-4 text-ink-muted">{programTitle}</td>
                    <td className="py-3 pr-4 text-ink-muted">
                      {offer.pricingType}
                      {offer.installments ? ` ×${offer.installments}` : ''}
                    </td>
                    <td className="py-3 pr-4">
                      {formatMoney(
                        offerTotalCents({
                          id: offer.id,
                          pricingType: offer.pricingType,
                          priceCents: offer.priceCents,
                          currency: offer.currency,
                          installments: offer.installments,
                          installmentIntervalDays: offer.installmentIntervalDays,
                          refundWindowDays: offer.refundWindowDays,
                        }),
                        offer.currency,
                      )}
                    </td>
                    <td className="py-3 pr-4 text-ink-muted">
                      {offer.refundWindowDays}d
                    </td>
                    <td className="py-3">
                      <OfferStatusBadge status={offer.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <Rule className="my-10" />

      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
        Coupons
      </h2>

      <div className="mt-5 border border-rule bg-alabaster p-4">
        <CouponForm offers={offerRows.map((r) => ({ id: r.offer.id, name: r.offer.name }))} />
      </div>

      {couponRows.length > 0 && (
        <table className="mt-6 w-full border-collapse text-2xs">
          <thead>
            <tr className="border-b border-rule-strong text-left text-ink-muted">
              <th className="py-2 pr-4 font-medium">Code</th>
              <th className="py-2 pr-4 font-medium">Discount</th>
              <th className="py-2 pr-4 font-medium">Used</th>
              <th className="py-2 pr-4 font-medium">Expires</th>
              <th className="py-2 font-medium">Active</th>
            </tr>
          </thead>
          <tbody>
            {couponRows.map((coupon) => (
              <tr key={coupon.id} className="border-b border-rule">
                <td className="py-3 pr-4 font-mono text-xs">{coupon.code}</td>
                <td className="py-3 pr-4 text-ink-muted">
                  {coupon.discountType === 'percent'
                    ? `${coupon.discountValue}%`
                    : formatMoney(coupon.discountValue)}
                </td>
                <td className="py-3 pr-4 text-ink-muted">
                  {coupon.redemptionCount}
                  {coupon.maxRedemptions ? ` / ${coupon.maxRedemptions}` : ''}
                </td>
                <td className="py-3 pr-4 text-ink-muted">
                  {coupon.expiresAt
                    ? coupon.expiresAt.toLocaleDateString('en-US')
                    : '—'}
                </td>
                <td className="py-3">
                  <CouponToggle couponId={coupon.id} isActive={coupon.isActive} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

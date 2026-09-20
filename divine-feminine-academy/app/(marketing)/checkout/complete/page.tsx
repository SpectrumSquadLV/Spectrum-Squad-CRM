import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { orders } from '@/db/schema'
import { Button, Rule } from '@/design-system/primitives'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'
import { formatMoney } from '@/features/commerce/pricing'

export const metadata = {
  title: 'Thank you',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

/**
 * Where she lands after paying.
 *
 * Access is granted by the WEBHOOK, not by arriving here — this page is just
 * the redirect target and anyone could visit it. If the webhook has not landed
 * yet, say so plainly rather than pretending.
 */
export default async function CheckoutCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string | string[] }>
}) {
  const params = await searchParams
  const orderId = Array.isArray(params.order) ? params.order[0] : params.order

  const [order] = orderId
    ? await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
    : []

  const paid = order?.status === 'paid'

  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Thank you</Eyebrow>
      <h1 className="mt-6 text-3xl">
        {paid ? 'You are in.' : 'That went through.'}
      </h1>

      <Prose className="mt-6 text-lg">
        {paid ? (
          <p>
            Your place is open. Everything you write stays yours, and the first
            day is waiting whenever you are.
          </p>
        ) : (
          <p>
            Your payment is confirming. It usually takes a few seconds — refresh
            this page, and if it has not opened in a minute or two, email us and
            we will sort it out.
          </p>
        )}
      </Prose>

      {order && (
        <>
          <Rule tone="gilt" className="my-10" />
          <dl className="grid grid-cols-2 gap-y-3 text-xs md:max-w-md">
            <dt className="text-ink-muted">Paid</dt>
            <dd>{formatMoney(order.totalCents, order.currency)}</dd>
            {order.discountCents > 0 && (
              <>
                <dt className="text-ink-muted">Discount</dt>
                <dd>−{formatMoney(order.discountCents, order.currency)}</dd>
              </>
            )}
            <dt className="text-ink-muted">Reference</dt>
            <dd className="font-mono text-2xs">{order.id.slice(0, 8)}</dd>
          </dl>
        </>
      )}

      <div className="mt-10 flex flex-wrap gap-4">
        <Button size="lg" asChild>
          <Link href="/my-academy">Go to your academy</Link>
        </Button>
      </div>
    </Section>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts, offers, programs } from '@/db/schema'
import { Button, Rule } from '@/design-system/primitives'
import { Eyebrow, Placeholder, Prose, Section } from '@/design-system/patterns'
import { CheckoutForm } from '@/features/commerce/CheckoutForm'
import { formatMoney, offerTotalCents } from '@/features/commerce/pricing'
import { getActor } from '@/lib/auth/actor-server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'The Academy',
  description:
    'The deeper work, across Self, Love, Life and Wealth — for women who have already met HER and want to stay.',
}

export default async function AcademyPage() {
  // Pricing is data: if there is an active offer, the page sells. If there is
  // not, it says so rather than inventing a number.
  const [row] = await db
    .select({ offer: offers })
    .from(offers)
    .innerJoin(programs, eq(programs.id, offers.programId))
    .where(and(eq(programs.slug, 'the-academy'), eq(offers.status, 'active')))
    .limit(1)

  // A woman already signed in should not have to retype her email.
  const actor = await getActor()
  const [signedIn] =
    actor.kind === 'user' && actor.contactId
      ? await db
          .select({ email: contacts.email })
          .from(contacts)
          .where(eq(contacts.id, actor.contactId))
          .limit(1)
      : []

  const offer = row?.offer
  const totalCents = offer
    ? offerTotalCents({
        id: offer.id,
        pricingType: offer.pricingType,
        priceCents: offer.priceCents,
        currency: offer.currency,
        installments: offer.installments,
        installmentIntervalDays: offer.installmentIntervalDays,
        refundWindowDays: offer.refundWindowDays,
      })
    : 0

  return (
    <>
      <Section className="pt-14 md:pt-24">
        <Eyebrow>The Academy</Eyebrow>
        <h1 className="mt-6 text-3xl md:text-4xl">
          Seven days will show you who she is.
          <br />
          This is where you stay.
        </h1>
        <Prose className="mt-8 text-lg">
          <p>
            The challenge gives you the practice. The Academy gives you the
            time, the depth and the company to make it the way you actually
            live — across all four areas, not just the one that hurts most right
            now.
          </p>
        </Prose>
      </Section>

      <Section>
        <Rule tone="gilt" />
        <Placeholder
          label="Needs your input"
          note="curriculum and format not written"
          className="mt-12"
        >
          <Prose className="text-sm">
            <p>
              This page needs the real shape of the Academy before it can sell
              anything: how long it runs, what is in it, whether it is
              self-paced or cohort-based, and what a woman actually gets in the
              first week.
            </p>
            <p>
              The structure underneath supports any of those. The copy cannot be
              written without you.
            </p>
          </Prose>
        </Placeholder>
      </Section>

      <Section>
        <h2 className="text-2xl">What carries over</h2>
        <Prose className="mt-4">
          <p>
            Everything. Your HER profile, every pattern you named, every time
            you logged choosing her, your RETURN practice and your HER Code — it
            is all already in your account, and the Academy builds on top of it
            rather than starting you over.
          </p>
          <p>
            This is the part a course platform cannot do. It does not know who
            you are becoming. This does.
          </p>
        </Prose>
      </Section>

      <Section className="pb-24">
        <Rule tone="gilt" />

        {offer ? (
          <div className="mt-12 max-w-md rounded-xl border border-rule bg-alabaster p-6 md:p-8">
            <h2 className="font-display text-xl">Join the Academy</h2>
            <div className="mt-6">
              <CheckoutForm
                offerId={offer.id}
                priceLabel={formatMoney(offer.priceCents, offer.currency)}
                planNote={
                  offer.pricingType === 'payment_plan' && offer.installments
                    ? `${offer.installments} payments · ${formatMoney(totalCents, offer.currency)} in total`
                    : undefined
                }
                refundNote={
                  offer.refundWindowDays > 0
                    ? `${offer.refundWindowDays}-day refund window.`
                    : undefined
                }
                signedInEmail={signedIn?.email ?? null}
              />
            </div>
          </div>
        ) : (
          <Placeholder
            label="Not on sale yet"
            note="no active offer"
            className="mt-12"
          >
            <p className="text-xs text-ink-soft">
              Checkout is built and tested, but nothing is being sold until an
              active offer exists. Create one in{' '}
              <code className="text-clay-deep">/admin/offers</code> — the price
              is a row there, never a number written into this page.
            </p>
          </Placeholder>
        )}

        <div className="mt-12">
          <h2 className="text-2xl">Start with the seven days</h2>
          <Prose className="mt-4">
            <p>
              The Academy is not the first step, and you should not take it
              until you have met her. Do the week first.
            </p>
          </Prose>
          <Button size="lg" className="mt-8" asChild>
            <Link href="/7-days-to-her">Start 7 Days to HER</Link>
          </Button>
        </div>
      </Section>
    </>
  )
}

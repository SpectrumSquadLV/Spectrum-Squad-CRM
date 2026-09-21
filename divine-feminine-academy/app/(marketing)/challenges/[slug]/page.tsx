import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Rule } from '@/design-system/primitives'
import {
  Eyebrow,
  Prose,
  PullQuote,
  Section,
  StaffNote,
} from '@/design-system/patterns'
import { challengeDays, getChallenge, listChallenges } from '@/db/queries/challenges'
import { CheckoutForm } from '@/features/commerce/CheckoutForm'
import { formatMoney } from '@/features/commerce/pricing'
import { JoinForm } from '@/features/auth/JoinForm'
import { CrisisResources } from '@/features/care/CrisisResources'
import { siteImage } from '@/db/queries/images'
import { SiteImage, SiteImageFrame } from '@/features/images/SiteImage'
import { imageSlot } from '@/features/images/slots'

export const dynamic = 'force-dynamic'

/**
 * One challenge, whichever it is.
 *
 * Everything on this page comes from the programme row, its published version
 * and its active offer. The days are the real modules, so editing Day 3 in
 * the admin changes what this page promises - before this, the seven days
 * lived in a const array on /me-vs-her and could quietly disagree with the
 * week a woman actually got.
 *
 * The page sells when there is an active offer and collects an email when
 * there is not. It never shows a price nobody set.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const challenge = await getChallenge(slug)
  if (!challenge) return { title: 'Not found' }

  return {
    title: challenge.title,
    description: challenge.subtitle ?? challenge.description ?? undefined,
    openGraph: {
      title: challenge.title,
      description: challenge.subtitle ?? undefined,
    },
  }
}

export default async function ChallengePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const challenge = await getChallenge(slug)
  if (!challenge) notFound()

  const [days, others] = await Promise.all([challengeDays(slug), listChallenges()])

  /*
   * A challenge gets its own photograph by naming one: the slot `<slug>-hero`.
   * If there is no such slot the page runs without a picture rather than
   * borrowing one from somewhere else - a portrait chosen for a different
   * page is worse than no portrait, and a staff note says so where only
   * Quiana can read it.
   */
  const slot = imageSlot(`${slug}-hero`)
  const hero = slot ? await siteImage(slot.key) : null

  const { offer } = challenge
  const elsewhere = others.filter((c) => c.slug !== slug)

  return (
    <>
      <Section className="pt-14 md:pt-24">
        <Eyebrow>
          {[
            challenge.durationDays ? `${challenge.durationDays} days` : null,
            offer ? formatMoney(offer.priceCents, offer.currency) : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'A challenge'}
        </Eyebrow>
        <h1 className="mt-6 text-3xl md:text-5xl">{challenge.title}</h1>

        {challenge.subtitle && (
          <Prose className="mt-8 text-lg">
            <p>{challenge.subtitle}</p>
          </Prose>
        )}

        {challenge.description && (
          <Prose className="mt-5 text-lg">
            <p>{challenge.description}</p>
          </Prose>
        )}

        {!challenge.subtitle && !challenge.description && (
          <StaffNote what={`the promise for ${challenge.title}`} className="mt-8">
            <p>
              This challenge has no subtitle or description, so its page opens
              with a title and nothing else. Both are fields on the programme
              in /admin/programs — the subtitle is the one-line promise, the
              description is the paragraph under it.
            </p>
          </StaffNote>
        )}

        {slot && hero && (
          <div className="mt-12">
            <SiteImageFrame slot={slot} className="rounded-xl">
              <SiteImage
                images={hero}
                slot={slot}
                priority
                sizes="(min-width: 768px) 56rem, 100vw"
              />
            </SiteImageFrame>
          </div>
        )}

        {!slot && (
          <StaffNote what={`a photograph for ${challenge.title}`} className="mt-10">
            <p>
              There is no image slot called <code>{slug}-hero</code>, so this
              page has no photograph. Add one to src/features/images/slots.ts
              with a desktop and a mobile crop, then upload in /admin/images.
            </p>
          </StaffNote>
        )}

        <div className="mt-12 max-w-md rounded-xl border border-rule bg-alabaster p-6 md:p-8">
          {offer ? (
            <>
              <h2 className="font-display text-xl">Start today</h2>
              <p className="mt-2 text-xs text-ink-muted">
                One payment. Yours to keep afterwards.
              </p>
              <div className="mt-6">
                <CheckoutForm
                  offerId={offer.id}
                  priceLabel={formatMoney(offer.priceCents, offer.currency)}
                  refundNote={
                    offer.refundWindowDays > 0
                      ? `If it is not right for you, you have ${offer.refundWindowDays} days to say so and get your money back.`
                      : undefined
                  }
                />
              </div>
            </>
          ) : (
            <>
              <h2 className="font-display text-xl">
                Tell me when the doors open
              </h2>
              <p className="mt-2 text-xs text-ink-muted">
                You will hear before anybody else, and you will not hear from
                me about anything else.
              </p>
              <JoinForm
                className="mt-6"
                source={`challenge:${slug}`}
                next="/my-practice"
                submitLabel="Put me on the list"
              />
              <StaffNote what={`a price for ${challenge.title}`} className="mt-6">
                <p>
                  There is no active offer for this programme, so the page
                  collects emails instead of taking money. Create one in
                  /admin/offers when you have decided — the price is a row
                  there, never a number written into a page.
                </p>
              </StaffNote>
            </>
          )}
        </div>
      </Section>

      {days.length > 0 && (
        <Section>
          <Rule tone="gilt" />
          <h2 className="mt-12 text-2xl md:text-4xl">
            {challenge.durationDays === days.length
              ? `The ${numberWord(days.length)} days`
              : 'What you do'}
          </h2>
          <ol className="mt-10 divide-y divide-rule border-y border-rule">
            {days.map((day) => (
              <li key={day.position} className="py-6">
                <Eyebrow>Day {day.position}</Eyebrow>
                <h3 className="mt-2 font-display text-xl">{day.title}</h3>
                {day.subtitle && (
                  <p className="measure mt-2 text-sm text-ink-soft">
                    {day.subtitle}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}

      {days.length === 0 && (
        <Section>
          <StaffNote what={`the days of ${challenge.title}`}>
            <p>
              This programme has no modules in its latest version, so the page
              cannot show what a woman actually does. Build them in
              /admin/programs — they are read from the same version a new
              enrolment pins, which is why the page and her account can never
              disagree.
            </p>
          </StaffNote>
        </Section>
      )}

      <Section>
        <h2 className="text-2xl md:text-4xl">What you leave with</h2>
        <Prose className="mt-6">
          <p>
            Not a certificate of attendance. Your own patterns in your own
            words, a count of the times you chose differently, and something
            you can hold yourself to afterwards.
          </p>
          <p>All of it stays in your account when the challenge ends.</p>
        </Prose>

        <PullQuote className="mt-12">
          The practice is not staying. It is <em>returning</em>.
        </PullQuote>
      </Section>

      {/* Where it goes. A challenge is a door, not the house. */}
      <Section>
        <Rule tone="gilt" />
        <Eyebrow className="mt-12">After this</Eyebrow>
        <h2 className="mt-6 text-2xl md:text-4xl">
          This is the beginning of the Divine Feminine.
        </h2>
        <Prose className="mt-6 text-lg">
          <p>
            A few days will show you the pattern. The Divine Feminine is where
            you change the life it has been running — the money, the love, the
            name you answer to when nobody is watching.
          </p>
          <p>Everything you do here carries over. You never start again.</p>
        </Prose>
        <Link
          href="/the-divine-feminine"
          className="mt-8 inline-flex min-h-11 items-center text-sm underline underline-offset-4 hover:text-clay-deep"
        >
          The Divine Feminine
        </Link>
      </Section>

      {elsewhere.length > 0 && (
        <Section>
          <h2 className="text-xl">Other ways in</h2>
          <ul className="mt-6 space-y-3">
            {elsewhere.map((other) => (
              <li key={other.slug}>
                <Link
                  href={`/challenges/${other.slug}`}
                  className="inline-flex min-h-11 items-center text-sm text-ink-soft underline underline-offset-4 hover:text-clay-deep"
                >
                  {other.title}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section className="pb-24">
        <Rule tone="gilt" />
        <div className="mt-12">
          <h2 className="text-2xl">Before you start</h2>
          <Prose className="mt-4 text-sm">
            <p>
              This is education, not therapy, and it is not a substitute for
              care from a professional. Some of this work asks you to look at
              painful things. If today is heavy, the people below are free and
              they answer now.
            </p>
          </Prose>
          <CrisisResources className="mt-6 max-w-md" />
        </div>
      </Section>
    </>
  )
}

/** Seven days reads better than 7 days in a heading. Numerals resume at ten. */
function numberWord(n: number): string {
  const words = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
  ]
  return words[n] ?? String(n)
}

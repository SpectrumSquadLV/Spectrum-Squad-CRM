import type { Metadata } from 'next'
import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts } from '@/db/schema'
import { Button, Rule } from '@/design-system/primitives'
import {
  Eyebrow,
  Prose,
  PullQuote,
  Section,
  StaffNote,
} from '@/design-system/patterns'
import { CheckoutForm } from '@/features/commerce/CheckoutForm'
import { JoinForm } from '@/features/auth/JoinForm'
import { CrisisResources } from '@/features/care/CrisisResources'
import { formatMoney, offerTotalCents } from '@/features/commerce/pricing'
import { enrolmentState } from '@/db/queries/enrolment-state'
import { listChallenges } from '@/db/queries/challenges'
import { getActor } from '@/lib/auth/actor-server'
import { siteImage } from '@/db/queries/images'
import { SiteImage, SiteImageFrame } from '@/features/images/SiteImage'
import { imageSlot } from '@/features/images/slots'

export const dynamic = 'force-dynamic'

export const DF_SLUG = 'the-divine-feminine'

export const metadata: Metadata = {
  title: 'The Divine Feminine',
  description:
    'The work of becoming the woman the life you want already belongs to — across love, money, success and receiving.',
  openGraph: {
    title: 'The Divine Feminine',
    description:
      'Not a mindset. A different relationship with what you expect, what you notice, and what you accept as evidence.',
  },
}

/**
 * THE DIVINE FEMININE.
 *
 * The destination, and the page the whole site is built to deliver somebody
 * to. It is written in the order a woman actually decides in: who she is now,
 * what she wants, why the things she has already tried did not touch it, what
 * is actually happening underneath, who she becomes, and only then what it
 * costs.
 *
 * TWO THINGS THIS PAGE REFUSES TO DO.
 *
 * It does not state a price that has not been decided. Enrolment is a state
 * machine over the offers table: active offer means a checkout, a draft offer
 * means the doors are opening, nothing means a waitlist. Quiana turns it on
 * in the admin, and no part of that needs a developer.
 *
 * It does not invent a curriculum. Everything here is about the
 * transformation, which is true whatever the modules turn out to be. What is
 * missing - the format, the length, what is in week one - sits in admin-only
 * notes rather than in a dashed amber box a stranger can read.
 */
export default async function DivineFemininePage() {
  const [state, hero, challenges, actor] = await Promise.all([
    enrolmentState(DF_SLUG),
    siteImage('divine-feminine-hero'),
    listChallenges(),
    getActor(),
  ])

  // A woman already signed in should not have to retype her email.
  const [signedIn] =
    actor.kind === 'user' && actor.contactId
      ? await db
          .select({ email: contacts.email })
          .from(contacts)
          .where(eq(contacts.id, actor.contactId))
          .limit(1)
      : []

  const firstDoor = challenges[0]

  return (
    <>
      <Section className="pt-14 md:pt-24">
        <Eyebrow>The work itself</Eyebrow>
        <h1 className="mt-6 text-4xl leading-none md:text-6xl">
          The Divine Feminine
        </h1>
        <Prose className="mt-10 text-xl md:text-2xl">
          <p>
            For the woman who already knows what she wants, has already done
            the work, and is still waiting for her life to catch up.
          </p>
        </Prose>

        {hero && (
          <div className="mt-12">
            <SiteImageFrame
              slot={imageSlot('divine-feminine-hero')!}
              className="rounded-xl"
            >
              <SiteImage
                images={hero}
                slot={imageSlot('divine-feminine-hero')!}
                priority
                sizes="(min-width: 768px) 56rem, 100vw"
              />
            </SiteImageFrame>
          </div>
        )}
      </Section>

      {/* Who she is now. Recognition before anything is offered. */}
      <Section>
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl md:text-4xl">
          You are not starting from nothing.
        </h2>
        <Prose className="mt-8 text-lg">
          <p>
            You are capable. You are self-aware. You can name the pattern while
            you are inside it, which most people cannot.
          </p>
          <p>
            And knowing it has not been enough to change it. That is not a
            failure of effort and it is not a character flaw — it is what
            happens when the thing running the pattern was never asking for
            your opinion.
          </p>
        </Prose>
      </Section>

      {/* Why the usual answers have not worked. */}
      <Section>
        <h2 className="text-2xl md:text-4xl">
          Why none of it stuck
        </h2>
        <Prose className="mt-8 text-lg">
          <p>
            Discipline works on behaviour. Planning works on sequence.
            Affirmations work on what you say. None of them work on what you{' '}
            <em>expect</em> — and expectation is the part choosing what you
            notice, what you dismiss, and what you count as evidence about
            yourself.
          </p>
          <p>
            So you change the behaviour and the life stays the same shape,
            which you then read as more evidence. That loop is the whole
            problem, and it is the thing this work goes at.
          </p>
        </Prose>
      </Section>

      {/*
        THE FRAMEWORK.
        The duty-of-care boundary in the last paragraph is not decoration and
        it does not come out: a page explaining that expectation shapes
        experience is one careless sentence away from telling a woman her
        circumstances are her fault. It is placed as part of the framework
        rather than as a disclaimer underneath it, because that is where it is
        actually load-bearing.
      */}
      <Section>
        <Rule tone="gilt" />
        <Eyebrow className="mt-12">What is actually happening</Eyebrow>
        <h2 className="mt-6 text-2xl md:text-4xl">
          The loop you are living inside
        </h2>

        <ol className="mt-12 divide-y divide-rule border-y border-rule">
          {[
            {
              step: 'Experience',
              body: 'Something happens. Often something you had no say in.',
            },
            {
              step: 'Meaning',
              body: 'You decide what it said about you. This is the only step that was ever yours.',
            },
            {
              step: 'Belief',
              body: 'Enough meanings in the same direction harden into something you stop questioning.',
            },
            {
              step: 'Expectation',
              body: 'The belief starts predicting. Before the room, before the conversation, before the invoice.',
            },
            {
              step: 'Attention',
              body: 'You notice what matches the prediction and slide past what does not.',
            },
            {
              step: 'Evidence',
              body: 'What you noticed becomes proof. The belief gets stronger. The loop runs again.',
            },
          ].map((row) => (
            <li key={row.step} className="py-6">
              <h3 className="font-display text-xl">{row.step}</h3>
              <p className="measure mt-2 text-base text-ink-soft">{row.body}</p>
            </li>
          ))}
        </ol>

        <Prose className="mt-12 text-lg">
          <p>
            To be exact about this, because it matters more than anything else
            on the page: <strong>you did not cause what happened to you.</strong>{' '}
            Not the abuse, not the illness, not the loss, not what other people
            chose, and not the conditions you were born into.
          </p>
          <p>
            The meaning you took from it is a different thing, and it is the
            only part of the loop standing where you can reach it. That is why
            this work starts there — not because the rest was your doing, but
            because the rest is not yours to move.
          </p>
        </Prose>
      </Section>

      {/* Who she becomes. */}
      <Section>
        <Rule tone="gilt" />
        <Eyebrow className="mt-12">Who you become</Eyebrow>
        <h2 className="mt-6 text-2xl md:text-4xl">
          She is not someone you become.
          <br />
          She is someone you <em>return to</em>.
        </h2>
        <Prose className="mt-8 text-lg">
          <p>
            There was a version of you who wanted things out loud before she
            learned what it cost. Everything since has been management — of
            other people, of your own expectations, of how much you let
            yourself want.
          </p>
          <p>
            The work is not adding a new woman. It is putting down the job the
            old one has been doing, and finding out she was never the problem
            either.
          </p>
        </Prose>

        <PullQuote className="mt-14">
          The practice is not staying. It is <em>returning</em>.
        </PullQuote>
      </Section>

      {/* What is inside. Structure public, specifics admin-only. */}
      <Section>
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl md:text-4xl">What you carry in</h2>
        <Prose className="mt-8 text-lg">
          <p>
            Everything from anything you have already done here. Your HER
            profile, every pattern you have named, every time you logged
            choosing her, your RETURN practice and your HER Code — it is all
            already in your account and this builds on top of it.
          </p>
          <p>
            You never start again. That is the part a course platform cannot
            do: it does not know who you are becoming. This does.
          </p>
        </Prose>

        <StaffNote what="what is inside — format, length, week one">
          <p>
            This section says what carries over, which is true today. What it
            cannot say is what the programme actually contains: how long it
            runs, whether it is self-paced or moves in cohorts, how often you
            appear live, and what a woman does in her first week.
          </p>
          <p>
            None of that is invented anywhere on this page. Send it and it goes
            in here; the structure around it is already built. The engine
            underneath supports any of those shapes — drip, cohort, or open —
            so the answer does not constrain the build.
          </p>
        </StaffNote>
      </Section>

      {/* Who it is for, and who it is not. */}
      <Section>
        <h2 className="text-2xl md:text-4xl">Who this is for</h2>
        <div className="mt-10 grid gap-10 md:grid-cols-2">
          <div>
            <h3 className="font-display text-xl">It is for you if</h3>
            <ul className="mt-5 space-y-4 text-base text-ink-soft">
              <li>You can already see the pattern and cannot stop running it.</li>
              <li>
                You have done enough work to know that more information is not
                the missing piece.
              </li>
              <li>
                You want this in your money and your relationships, not only in
                how you feel on a Sunday.
              </li>
              <li>You are willing to be honest somewhere nobody is reading.</li>
            </ul>
          </div>
          <div>
            <h3 className="font-display text-xl">It is not for you if</h3>
            <ul className="mt-5 space-y-4 text-base text-ink-soft">
              <li>
                You are in crisis right now. That needs a person, today, and
                there are numbers at the bottom of this page.
              </li>
              <li>
                You want somebody to tell you what your life means. That part
                stays yours.
              </li>
              <li>You are looking for therapy. This is education, and it is not a substitute.</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ENROLMENT. Three states, all of them data. */}
      <Section>
        <Rule tone="gilt" />
        <div className="mt-12 max-w-md rounded-xl border border-rule bg-alabaster p-6 md:p-8">
          {state.kind === 'open' ? (
            <>
              <h2 className="font-display text-xl">Join the Divine Feminine</h2>
              <div className="mt-6">
                <CheckoutForm
                  offerId={state.offer.id}
                  priceLabel={formatMoney(
                    state.offer.priceCents,
                    state.offer.currency,
                  )}
                  planNote={
                    state.offer.pricingType === 'payment_plan' &&
                    state.offer.installments
                      ? `${state.offer.installments} payments · ${formatMoney(
                          offerTotalCents(state.offer),
                          state.offer.currency,
                        )} in total`
                      : undefined
                  }
                  refundNote={
                    state.offer.refundWindowDays > 0
                      ? `${state.offer.refundWindowDays}-day refund window.`
                      : undefined
                  }
                  signedInEmail={signedIn?.email ?? null}
                />
              </div>
            </>
          ) : (
            <>
              <h2 className="font-display text-xl">
                {state.kind === 'opening'
                  ? 'The doors are opening'
                  : 'Be told before anybody else'}
              </h2>
              <p className="mt-2 text-xs text-ink-muted">
                {state.kind === 'opening'
                  ? 'Leave your email and you will hear the moment enrolment opens — before it goes anywhere public.'
                  : 'The Divine Feminine is being built now. You will hear when it opens, and you will not hear from me about anything else.'}
              </p>
              <JoinForm
                className="mt-6"
                source="the-divine-feminine"
                next="/my-academy"
                submitLabel="Put me on the list"
              />
            </>
          )}
        </div>

        {state.kind === 'unknown' && (
          <StaffNote what="the Divine Feminine programme row" className="mt-8">
            <p>
              There is no programme with the slug “{DF_SLUG}”, so this page
              cannot know anything about enrolment and falls back to a plain
              waitlist. Create it in /admin/programs; the page picks it up with
              no deploy.
            </p>
          </StaffNote>
        )}

        {state.kind !== 'open' && state.kind !== 'unknown' && (
          <StaffNote what="a price, when you have decided one" className="mt-8">
            <p>
              This page is currently a{' '}
              {state.kind === 'opening' ? 'doors-opening' : 'waitlist'} page
              because {state.kind === 'opening'
                ? 'there is a draft offer but none active'
                : 'there is no offer at all'}
              . Activate one in /admin/offers and it becomes a checkout by
              itself. Nothing here needs editing and nothing needs deploying.
            </p>
            <p>
              Nowhere on this page is a number stated. That is deliberate — a
              visible price that cannot be paid is a promise the site cannot
              keep.
            </p>
          </StaffNote>
        )}
      </Section>

      {/* Objections, answered plainly. */}
      <Section>
        <h2 className="text-2xl md:text-4xl">
          The things you are already thinking
        </h2>
        <dl className="mt-10 divide-y divide-rule border-y border-rule">
          {[
            {
              q: 'I have done this kind of thing before and nothing changed.',
              a: 'Then you already know that understanding is not the mechanism. This goes at expectation and evidence, which is the part that was running underneath while you were understanding.',
            },
            {
              q: 'I do not have time.',
              a: 'It is built for a phone and for a woman with a full life. The work is short and repeated, because that is what actually moves an expectation — not an intensive weekend you never repeat.',
            },
            {
              q: 'What if I write something I do not want anybody to see?',
              a: 'Your journal is encrypted before it reaches the database. Not permissioned — encrypted, so nobody who works here can read it, including me. We can see that you wrote. We cannot see what.',
            },
            {
              q: 'Is this therapy?',
              a: 'No, and it is not a substitute for it. It is education about a pattern. If you are working with somebody, this sits alongside that rather than replacing it.',
            },
          ].map((row) => (
            <div key={row.q} className="py-6">
              <dt className="font-display text-lg">{row.q}</dt>
              <dd className="measure mt-2 text-base text-ink-soft">{row.a}</dd>
            </div>
          ))}
        </dl>

        <Button variant="link" className="mt-8" asChild>
          <Link href="/legal/privacy">How the encryption works</Link>
        </Button>
      </Section>

      {/* A smaller first step, for the woman who is not ready for this one. */}
      {firstDoor && (
        <Section>
          <Rule tone="gilt" />
          <h2 className="mt-12 text-2xl md:text-4xl">
            Not ready for all of it?
          </h2>
          <Prose className="mt-8 text-lg">
            <p>
              Start with a challenge. It is short, it is specific, and
              everything you do in it carries into this.
            </p>
          </Prose>
          <Button size="lg" className="mt-8" asChild>
            <Link href={`/challenges/${firstDoor.slug}`}>
              Start {firstDoor.title}
            </Link>
          </Button>
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

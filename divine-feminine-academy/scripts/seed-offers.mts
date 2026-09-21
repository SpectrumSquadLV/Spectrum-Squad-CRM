/**
 * Seeds the two things there are to buy.
 *
 * ME VS HER at $11, ACTIVE. Eleven dollars is a decision that has been made,
 * so the offer is live rather than draft — a seeded draft would mean the way
 * in to the whole funnel was quietly unpurchasable on launch day.
 *
 * The Divine Feminine, the full course, as two DRAFT shapes. Its price is
 * still an open decision, and activating one is a form in /admin/offers rather
 * than a code change.
 *
 * Run: DATABASE_URL=... npm run seed:offers
 */
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { certificateRequirements } from '../src/db/schema/certificates'
// From the concrete modules, not the barrel: `export *` does not resolve to
// named ESM bindings under tsx's transpile-only loader.
import { offers } from '../src/db/schema/commerce'
import { programs, programVersions } from '../src/db/schema/programs'

const PLACEHOLDER = '[PLACEHOLDER COPY — awaiting the real curriculum]'

async function main() {
  const [program] = await db
    .insert(programs)
    .values({
      slug: 'the-divine-feminine',
      title: 'The Divine Feminine',
      subtitle: 'The deeper work, across Self, Love, Life and Wealth.',
      description: PLACEHOLDER,
      kind: 'program',
      status: 'draft',
      pacing: 'drip',
      allowEarlyUnlock: false,
    })
    .onConflictDoUpdate({
      target: programs.slug,
      set: { updatedAt: new Date() },
    })
    .returning()

  if (!program) throw new Error('could not upsert the programme')

  const [existingVersion] = await db
    .select()
    .from(programVersions)
    .where(eq(programVersions.programId, program.id))
    .limit(1)

  if (!existingVersion) {
    await db.insert(programVersions).values({ programId: program.id, version: 1 })
  }

  await db
    .insert(certificateRequirements)
    .values({
      programId: program.id,
      requirementType: 'lessons_completed_pct',
      threshold: 100,
    })
    .onConflictDoNothing({
      target: [
        certificateRequirements.programId,
        certificateRequirements.requirementType,
      ],
    })

  /*
   * Both shapes the architecture document left open, seeded side by side so
   * the decision is a click rather than a migration. $1,000 once, or three
   * payments of $375 (which totals $1,125 - the plan costs more, as plans do).
   */
  const drafts = [
    {
      name: 'The Divine Feminine — one payment',
      pricingType: 'one_time' as const,
      priceCents: 100_000,
      installments: null,
      installmentIntervalDays: null,
    },
    {
      name: 'The Divine Feminine — three payments',
      pricingType: 'payment_plan' as const,
      priceCents: 37_500,
      installments: 3,
      installmentIntervalDays: 30,
    },
  ]

  let created = 0
  for (const draft of drafts) {
    const [existing] = await db
      .select({ id: offers.id })
      .from(offers)
      .where(eq(offers.name, draft.name))
      .limit(1)
    if (existing) continue

    await db.insert(offers).values({
      programId: program.id,
      ...draft,
      currency: 'usd',
      refundWindowDays: 14,
      status: 'draft',
    })
    created++
  }

  /*
   * ME VS HER at $11.
   *
   * The price is upserted by name on every run, so correcting it here corrects
   * it everywhere. The programme has to exist first: `seed:challenge` creates
   * it, and without it there is nothing to attach a price to.
   */
  const [challenge] = await db
    .select({ id: programs.id })
    .from(programs)
    .where(eq(programs.slug, 'me-vs-her'))
    .limit(1)

  let challengeOffer = 'not seeded — run seed:challenge first'
  if (challenge) {
    const name = 'ME VS HER — the 7-day challenge'
    const values = {
      programId: challenge.id,
      name,
      pricingType: 'one_time' as const,
      priceCents: 1_100,
      installments: null,
      installmentIntervalDays: null,
      currency: 'usd',
      refundWindowDays: 14,
      status: 'active' as const,
    }

    const [existing] = await db
      .select({ id: offers.id })
      .from(offers)
      .where(eq(offers.name, name))
      .limit(1)

    if (existing) {
      await db
        .update(offers)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(offers.id, existing.id))
      challengeOffer = '$11, active (updated)'
    } else {
      await db.insert(offers).values(values)
      challengeOffer = '$11, active (created)'
    }
  }

  console.log(`ME VS HER: ${challengeOffer}`)
  console.log(`The Divine Feminine: ${created} draft offer(s)`)
  console.log('the full course is DRAFT: its price is still an open decision')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

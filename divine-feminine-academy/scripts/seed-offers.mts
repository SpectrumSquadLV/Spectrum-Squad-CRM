/**
 * Seeds the Academy programme and two DRAFT offers.
 *
 * Deliberately draft, not active: the price and the refund window are still
 * open decisions, and nothing should be purchasable until somebody chooses.
 * Activating an offer is a form in /admin/offers, not a code change.
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
      slug: 'the-academy',
      title: 'The Academy',
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
      name: 'The Academy — one payment',
      pricingType: 'one_time' as const,
      priceCents: 100_000,
      installments: null,
      installmentIntervalDays: null,
    },
    {
      name: 'The Academy — three payments',
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

  console.log(`seeded "The Academy" and ${created} draft offer(s)`)
  console.log('both are DRAFT: nothing is purchasable until you activate one')
  console.log('price and refund window are still open decisions')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

import 'server-only'

import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { modules, offers, programVersions, programs } from '@/db/schema'
import { publicText } from '@/lib/utils/placeholder'

/**
 * The challenges, for the public site.
 *
 * ME VS HER is the first of these, not the only one. The whole point of this
 * file is that the second one - identity, money, boundaries, receiving,
 * whichever she writes next - needs a row and a seed script, not a route and
 * a rebuild. Nothing here names a challenge.
 *
 * No actor, and no permission check, because every row it can return is
 * already published to the world. A draft programme never leaves this file.
 */

export interface PublicChallenge {
  slug: string
  title: string
  subtitle: string | null
  description: string | null
  durationDays: number | null
  /** Null when nothing is on sale. The page says so; it never invents one. */
  offer: {
    id: string
    priceCents: number
    currency: string
    pricingType: string
    installments: number | null
    refundWindowDays: number
  } | null
}

/**
 * Published challenges, cheapest offer first within each.
 *
 * Two queries rather than a join, because a left join against offers
 * multiplies a challenge by its offers and then has to be de-duplicated in
 * application code - which is where the wrong price gets picked.
 */
export async function listChallenges(): Promise<PublicChallenge[]> {
  const rows = await db
    .select({
      id: programs.id,
      slug: programs.slug,
      title: programs.title,
      subtitle: programs.subtitle,
      description: programs.description,
      durationDays: programs.durationDays,
    })
    .from(programs)
    .where(and(eq(programs.kind, 'challenge'), eq(programs.status, 'published')))
    .orderBy(asc(programs.createdAt))

  if (rows.length === 0) return []

  const priced = await db
    .select({
      id: offers.id,
      programId: offers.programId,
      priceCents: offers.priceCents,
      currency: offers.currency,
      pricingType: offers.pricingType,
      installments: offers.installments,
      refundWindowDays: offers.refundWindowDays,
    })
    .from(offers)
    .where(
      and(
        inArray(
          offers.programId,
          rows.map((r) => r.id),
        ),
        eq(offers.status, 'active'),
      ),
    )
    .orderBy(asc(offers.priceCents))

  const byProgram = new Map<string, (typeof priced)[number]>()
  for (const offer of priced) {
    // First wins, and the list is ordered by price, so the entry point is the
    // cheapest way in. A woman meeting a challenge for the first time should
    // see the lowest door, not whichever row was inserted first.
    if (!byProgram.has(offer.programId)) byProgram.set(offer.programId, offer)
  }

  return rows.map((row) => {
    const offer = byProgram.get(row.id)
    return {
      slug: row.slug,
      title: row.title,
      // Run through publicText, not straight out of the row. The curriculum
      // seeds an unwritten description as a build marker, and a marketing page
      // printing [NEEDS QUIANA'S INPUT] as the promise is the single worst
      // thing this file could do.
      subtitle: publicText(row.subtitle),
      description: publicText(row.description),
      durationDays: row.durationDays,
      offer: offer
        ? {
            id: offer.id,
            priceCents: offer.priceCents,
            currency: offer.currency,
            pricingType: offer.pricingType,
            installments: offer.installments,
            refundWindowDays: offer.refundWindowDays,
          }
        : null,
    }
  })
}

/** One challenge by slug, or null if it is not published. */
export async function getChallenge(slug: string): Promise<PublicChallenge | null> {
  const all = await listChallenges()
  return all.find((c) => c.slug === slug) ?? null
}

/**
 * The days, from the published version's modules.
 *
 * Read from the database rather than written into a page, so that editing Day
 * 3 in the admin changes the sales page too. Before this, the seven days on
 * /me-vs-her were a const array in the route and could - did - drift from the
 * days a woman actually gets.
 */
export interface ChallengeDay {
  position: number
  title: string
  subtitle: string | null
}

export async function challengeDays(slug: string): Promise<ChallengeDay[]> {
  /*
   * The HIGHEST version, matching getPublishedVersion, which is what a new
   * enrolment pins. Any other choice here would put one set of days on the
   * sales page and a different set in her account - and the day she noticed
   * would be the day she stopped trusting the rest of it.
   */
  const [version] = await db
    .select({ id: programVersions.id })
    .from(programVersions)
    .innerJoin(programs, eq(programs.id, programVersions.programId))
    .where(and(eq(programs.slug, slug), eq(programs.status, 'published')))
    .orderBy(desc(programVersions.version))
    .limit(1)

  if (!version) return []

  const rows = await db
    .select({
      position: modules.position,
      title: modules.title,
      subtitle: modules.subtitle,
    })
    .from(modules)
    .where(eq(modules.versionId, version.id))
    .orderBy(asc(modules.position))

  return rows.map((row) => ({ ...row, subtitle: publicText(row.subtitle) }))
}

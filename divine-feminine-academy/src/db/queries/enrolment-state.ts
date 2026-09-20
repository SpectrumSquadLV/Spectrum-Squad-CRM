import 'server-only'

import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { offers, programs } from '@/db/schema'

/**
 * Whether a programme can be joined, and how.
 *
 * Built as a state machine over data rather than a flag on a page, because
 * the alternative is a hard-coded button that has to be edited and deployed
 * every time the doors open or shut. Quiana activates an offer in /admin/offers
 * and the page becomes a checkout; she archives it and the page becomes a
 * waitlist again. Nobody touches code either way.
 *
 * There is deliberately no fourth state for "coming soon with a price". A
 * price that is visible but not payable is a promise the site cannot keep,
 * and the one thing worse than not knowing the price is being told one that
 * turns out not to be it.
 */
export type EnrolmentState =
  /** An active offer. She can buy it right now. */
  | { kind: 'open'; offer: OfferRow }
  /** An offer exists but is not active yet. The doors are not open. */
  | { kind: 'opening'; }
  /** Nothing priced at all. Interest only. */
  | { kind: 'waitlist' }
  /** No such programme. Nothing to enrol in and nothing to wait for. */
  | { kind: 'unknown' }

export interface OfferRow {
  id: string
  name: string
  pricingType: 'free' | 'one_time' | 'payment_plan' | 'subscription'
  priceCents: number
  currency: string
  installments: number | null
  installmentIntervalDays: number | null
  refundWindowDays: number
}

export async function enrolmentState(slug: string): Promise<EnrolmentState> {
  const [program] = await db
    .select({ id: programs.id })
    .from(programs)
    .where(eq(programs.slug, slug))
    .limit(1)

  if (!program) return { kind: 'unknown' }

  const rows = await db
    .select({
      id: offers.id,
      name: offers.name,
      pricingType: offers.pricingType,
      priceCents: offers.priceCents,
      currency: offers.currency,
      installments: offers.installments,
      installmentIntervalDays: offers.installmentIntervalDays,
      refundWindowDays: offers.refundWindowDays,
      status: offers.status,
    })
    .from(offers)
    .where(eq(offers.programId, program.id))
    .orderBy(asc(offers.priceCents))

  const active = rows.find((row) => row.status === 'active')
  if (active) {
    const { status: _status, ...offer } = active
    return { kind: 'open', offer }
  }

  // A draft offer means somebody has started pricing it. That is a different
  // thing to say than "there is no plan yet", and a woman deciding whether to
  // leave her email deserves the difference.
  if (rows.some((row) => row.status === 'draft')) return { kind: 'opening' }

  return { kind: 'waitlist' }
}

/** The same question for a challenge, where the answer is usually 'open'. */
export async function isOpen(slug: string): Promise<boolean> {
  const state = await enrolmentState(slug)
  return state.kind === 'open'
}

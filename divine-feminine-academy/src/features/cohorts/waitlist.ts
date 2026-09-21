import 'server-only'

import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import { activityEvents } from '@/db/schema/activity'
import { cohortWaitlist, cohorts } from '@/db/schema/programs'
import { findOrCreateLead, tagContact } from '@/db/queries/leads'
import { getCohortById } from '@/db/queries/cohorts'

export const waitlistInput = z.object({
  cohortId: z.string().uuid(),
  firstName: z.string().trim().min(1, 'Tell me what to call you.').max(80),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('That address does not look right.'),
})

export type WaitlistInput = z.infer<typeof waitlistInput>

export type WaitlistOutcome =
  | { ok: true; alreadyOn: boolean; phase: string }
  | { ok: false; error: string }

/**
 * Put her on the waitlist for a live run.
 *
 * This is the single most valuable form on the site, because it is the only
 * one somebody fills in BEFORE there is anything to buy. A woman who asks to
 * be told when the doors open has already decided; the launch is then a
 * reminder rather than a pitch.
 *
 * Idempotent. Asking twice is a woman checking she did it, not a mistake to
 * punish with an error.
 */
export async function joinCohortWaitlist(
  input: WaitlistInput,
): Promise<WaitlistOutcome> {
  const detail = await getCohortById(db, input.cohortId)
  if (!detail) return { ok: false, error: 'That group does not exist.' }
  if (!detail.window.isPublic) {
    return { ok: false, error: 'That group is not open.' }
  }

  const contactId = await findOrCreateLead(db, {
    email: input.email,
    firstName: input.firstName,
    source: `cohort-waitlist:${detail.cohort.slug ?? detail.cohort.id}`,
  })
  if (!contactId) return { ok: false, error: 'That did not save. Try again.' }

  const [existing] = await db
    .select({ id: cohortWaitlist.id })
    .from(cohortWaitlist)
    .where(
      and(
        eq(cohortWaitlist.cohortId, detail.cohort.id),
        eq(cohortWaitlist.contactId, contactId),
      ),
    )
    .limit(1)

  if (existing) {
    return { ok: true, alreadyOn: true, phase: detail.window.phase }
  }

  await db
    .insert(cohortWaitlist)
    .values({ cohortId: detail.cohort.id, contactId })
    .onConflictDoNothing()

  await tagContact(db, contactId, {
    slug: 'cohort-waitlist',
    name: 'Cohort waitlist',
  })

  await db.insert(activityEvents).values({
    contactId,
    eventType: 'cohort.waitlisted',
    entity: 'cohorts',
    entityId: detail.cohort.id,
    metadata: {
      slug: detail.cohort.slug,
      name: detail.cohort.name,
      phase: detail.window.phase,
    },
  })

  return { ok: true, alreadyOn: false, phase: detail.window.phase }
}

/**
 * Anybody already on the waitlist when the doors open is notified once.
 *
 * `notifiedAt` is per-woman rather than per-cohort so somebody who joins the
 * waitlist AFTER the doors opened is still told — she would otherwise be
 * silently skipped because the cohort as a whole was already announced.
 */
export async function pendingWaitlist(cohortId: string) {
  return db
    .select({ id: cohortWaitlist.id, contactId: cohortWaitlist.contactId })
    .from(cohortWaitlist)
    .where(
      and(
        eq(cohortWaitlist.cohortId, cohortId),
        isNull(cohortWaitlist.notifiedAt),
      ),
    )
}

export { cohorts }

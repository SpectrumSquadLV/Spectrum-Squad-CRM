import 'server-only'

import { and, asc, count, eq, isNull, ne, or, sql } from 'drizzle-orm'
import { cohortSessions, cohortWaitlist, cohorts, programs } from '../schema/programs'
import { enrollments } from '../schema/progress'
import { offers } from '../schema/commerce'
import { cohortWindow, type CohortWindow } from '@/features/cohorts/window'
import type { QueryContext } from './_context'

export type CohortRow = typeof cohorts.$inferSelect
export type CohortSessionRow = typeof cohortSessions.$inferSelect

/**
 * How many seats are gone.
 *
 * Counts enrolments rather than orders, because an enrolment is what a seat
 * actually is — a free cohort has no orders at all. A refunded enrolment gives
 * its chair back; everything else, including a paused one, is still somebody's
 * place in the room.
 */
export async function seatsTaken(
  db: QueryContext['db'],
  cohortId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.cohortId, cohortId),
        ne(enrollments.status, 'refunded'),
      ),
    )
  return Number(row?.n ?? 0)
}

export interface CohortDetail {
  cohort: CohortRow
  program: typeof programs.$inferSelect
  offer: typeof offers.$inferSelect | null
  sessions: CohortSessionRow[]
  window: CohortWindow
  seatsTaken: number
}

async function assemble(
  db: QueryContext['db'],
  row: { cohort: CohortRow; program: typeof programs.$inferSelect },
  now: Date,
): Promise<CohortDetail> {
  const [taken, sessions, offer] = await Promise.all([
    seatsTaken(db, row.cohort.id),
    db
      .select()
      .from(cohortSessions)
      .where(eq(cohortSessions.cohortId, row.cohort.id))
      .orderBy(asc(cohortSessions.startsAt)),
    row.cohort.offerId
      ? db
          .select()
          .from(offers)
          .where(eq(offers.id, row.cohort.offerId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ])

  const window = cohortWindow({
    status: row.cohort.status,
    startsAt: row.cohort.startsAt,
    endsAt: row.cohort.endsAt,
    timezone: row.cohort.timezone,
    enrollmentOpensAt: row.cohort.enrollmentOpensAt,
    enrollmentClosesAt: row.cohort.enrollmentClosesAt,
    capacity: row.cohort.capacity,
    seatsTaken: taken,
    durationDays: row.program.durationDays ?? 7,
    now,
  })

  return { cohort: row.cohort, program: row.program, offer, sessions, window, seatsTaken: taken }
}

export async function getCohortBySlug(
  db: QueryContext['db'],
  slug: string,
  now = new Date(),
): Promise<CohortDetail | null> {
  const [row] = await db
    .select({ cohort: cohorts, program: programs })
    .from(cohorts)
    .innerJoin(programs, eq(programs.id, cohorts.programId))
    .where(eq(cohorts.slug, slug))
    .limit(1)

  if (!row) return null
  return assemble(db, row, now)
}

export async function getCohortById(
  db: QueryContext['db'],
  id: string,
  now = new Date(),
): Promise<CohortDetail | null> {
  const [row] = await db
    .select({ cohort: cohorts, program: programs })
    .from(cohorts)
    .innerJoin(programs, eq(programs.id, cohorts.programId))
    .where(eq(cohorts.id, id))
    .limit(1)

  if (!row) return null
  return assemble(db, row, now)
}

/** Everything a visitor is allowed to see, soonest first. */
export async function listPublicCohorts(
  db: QueryContext['db'],
  now = new Date(),
): Promise<CohortDetail[]> {
  const rows = await db
    .select({ cohort: cohorts, program: programs })
    .from(cohorts)
    .innerJoin(programs, eq(programs.id, cohorts.programId))
    .where(and(eq(cohorts.status, 'scheduled'), sql`${cohorts.slug} is not null`))
    .orderBy(asc(cohorts.startsAt))

  const detailed = await Promise.all(rows.map((row) => assemble(db, row, now)))
  return detailed.filter((d) => d.window.isPublic && d.window.phase !== 'finished')
}

/** The one to put in front of somebody: open first, then soonest. */
export async function featuredCohort(
  db: QueryContext['db'],
  now = new Date(),
): Promise<CohortDetail | null> {
  const open = await listPublicCohorts(db, now)
  return (
    open.find((c) => c.window.canEnroll) ??
    open.find((c) => c.window.phase === 'announced') ??
    open[0] ??
    null
  )
}

export async function listAllCohorts(
  db: QueryContext['db'],
  now = new Date(),
): Promise<CohortDetail[]> {
  const rows = await db
    .select({ cohort: cohorts, program: programs })
    .from(cohorts)
    .innerJoin(programs, eq(programs.id, cohorts.programId))
    .orderBy(asc(cohorts.startsAt))

  return Promise.all(rows.map((row) => assemble(db, row, now)))
}

export async function isOnWaitlist(
  db: QueryContext['db'],
  cohortId: string,
  contactId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: cohortWaitlist.id })
    .from(cohortWaitlist)
    .where(
      and(
        eq(cohortWaitlist.cohortId, cohortId),
        eq(cohortWaitlist.contactId, contactId),
      ),
    )
    .limit(1)
  return Boolean(row)
}

export async function waitlistSize(
  db: QueryContext['db'],
  cohortId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(cohortWaitlist)
    .where(eq(cohortWaitlist.cohortId, cohortId))
  return Number(row?.n ?? 0)
}

export async function cohortSlugTaken(
  db: QueryContext['db'],
  slug: string,
  exceptId?: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: cohorts.id })
    .from(cohorts)
    .where(
      exceptId
        ? and(eq(cohorts.slug, slug), ne(cohorts.id, exceptId))
        : eq(cohorts.slug, slug),
    )
    .limit(1)
  return Boolean(row)
}

export { isNull, or }

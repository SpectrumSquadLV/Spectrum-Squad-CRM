import 'server-only'

import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
  blockResponses,
  cohorts,
  contacts,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  orderItems,
  orders,
  profiles,
  programs,
} from '@/db/schema'
import { computeUnlockState, safeTimeZone, type Pacing } from '@/features/challenge/pacing'
import { sendToContact } from '@/features/email/send'
import {
  abandonedCheckout,
  academyInvitation,
  dayReminder,
  nudge,
} from '@/features/email/templates'

/**
 * The scheduled jobs.
 *
 * These are the ones that cannot be driven by an event, because the thing that
 * happened is the passage of time: a day opened, or a woman did not come back.
 *
 * Every send carries an idempotency key built from what it is about, so the
 * cron can run every hour — or twice at once — without anybody being emailed
 * twice.
 */

/** The hour it currently is where she is. */
export function localHour(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now)
  return Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
}

/** The civil date where she is, as YYYY-MM-DD. Part of the idempotency key. */
export function localDateKey(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export interface JobSummary {
  considered: number
  sent: number
  skipped: number
}

/**
 * Send "Day N is open" to everybody whose local time has reached her hour.
 *
 * Run hourly. The idempotency key includes her local DATE and the day number,
 * so she gets one reminder per day per day — no matter how often this runs.
 */
export async function sendDayReminders(
  db: Db,
  siteUrl: string,
  now = new Date(),
): Promise<JobSummary> {
  const rows = await db
    .select({
      enrollment: enrollments,
      program: programs,
      contact: contacts,
      prefs: profiles.notificationPrefs,
      cohortTimezone: cohorts.timezone,
      cohortStartsAt: cohorts.startsAt,
    })
    .from(enrollments)
    .innerJoin(programs, eq(programs.id, enrollments.programId))
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .leftJoin(profiles, eq(profiles.contactId, enrollments.contactId))
    .leftJoin(cohorts, eq(cohorts.id, enrollments.cohortId))
    .where(and(eq(enrollments.status, 'active'), isNull(contacts.archivedAt)))

  const summary: JobSummary = { considered: rows.length, sent: 0, skipped: 0 }

  for (const row of rows) {
    const prefs = (row.prefs ?? {}) as { dailyEmail?: boolean; reminderHour?: number }
    if (prefs.dailyEmail === false) {
      summary.skipped++
      continue
    }

    const timeZone = row.enrollment.timezoneAtStart
    const reminderHour = Number.isInteger(prefs.reminderHour)
      ? (prefs.reminderHour as number)
      : 8

    // Only at her hour, in her timezone. This is the whole point.
    if (localHour(now, timeZone) !== reminderHour) {
      summary.skipped++
      continue
    }

    const [completedAgg] = await db
      .select({ day: sql<number>`coalesce(max(${modules.position}), 0)` })
      .from(lessonProgress)
      .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .where(
        and(
          eq(lessonProgress.enrollmentId, row.enrollment.id),
          eq(lessonProgress.status, 'completed'),
          eq(modules.versionId, row.enrollment.versionId),
        ),
      )

    const [dayCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(modules)
      .where(eq(modules.versionId, row.enrollment.versionId))

    const durationDays = Number(dayCount?.n ?? 0)
    if (durationDays === 0) {
      summary.skipped++
      continue
    }

    /*
     * Two different clocks, on purpose.
     *
     * `timeZone` above decides WHEN to send — her morning, wherever she is.
     * This decides WHICH DAY has opened, and under cohort pacing that is the
     * cohort's clock, because everybody in a live run has to be on the same
     * day as the live call.
     */
    const pacing = row.program.pacing as Pacing
    const unlockTimeZone =
      (pacing === 'cohort' || pacing === 'date_based') && row.cohortTimezone
        ? row.cohortTimezone
        : timeZone

    const unlock = computeUnlockState({
      pacing,
      startedAt: row.enrollment.startedAt,
      now,
      timeZone: unlockTimeZone,
      durationDays,
      allowEarlyUnlock: row.program.allowEarlyUnlock,
      highestCompletedDay: Number(completedAgg?.day ?? 0),
      cohortStartsAt: row.cohortStartsAt ?? null,
    })

    if (unlock.isComplete) {
      summary.skipped++
      continue
    }

    // Nothing new has opened; she is simply mid-day.
    if (unlock.currentDay > unlock.unlockedThrough) {
      summary.skipped++
      continue
    }

    const [dayModule] = await db
      .select({ title: modules.title })
      .from(modules)
      .where(
        and(
          eq(modules.versionId, row.enrollment.versionId),
          eq(modules.position, unlock.currentDay),
        ),
      )
      .limit(1)

    const rendered = dayReminder({
      firstName: row.contact.firstName,
      dayNumber: unlock.currentDay,
      dayTitle: dayModule?.title ?? `Day ${unlock.currentDay}`,
      totalDays: durationDays,
      programSlug: row.program.slug,
      siteUrl,
    })

    const outcome = await sendToContact({
      db,
      contactId: row.contact.id,
      rendered,
      kind: 'lifecycle',
      templateSlug: 'day-reminder',
      // Her local date AND the day number: one reminder per calendar day, and
      // never the same day's reminder twice.
      idempotencyKey: `day-reminder:${row.enrollment.id}:${unlock.currentDay}:${localDateKey(now, timeZone)}`,
    })

    if (outcome.sent) summary.sent++
    else summary.skipped++
  }

  return summary
}

/**
 * One nudge to a woman who has not come back in a few days.
 *
 * Said once per stall, not once per day. The key is the day she is stuck on,
 * so moving forward and stalling again earns one more — and staying stuck
 * earns silence.
 */
export async function sendStallNudges(
  db: Db,
  siteUrl: string,
  now = new Date(),
  afterDays = 3,
): Promise<JobSummary> {
  const cutoff = new Date(now.getTime() - afterDays * 86_400_000)

  const rows = await db
    .select({
      enrollment: enrollments,
      program: programs,
      contact: contacts,
    })
    .from(enrollments)
    .innerJoin(programs, eq(programs.id, enrollments.programId))
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .where(
      and(
        eq(enrollments.status, 'active'),
        isNull(contacts.archivedAt),
        lt(enrollments.updatedAt, cutoff),
      ),
    )

  const summary: JobSummary = { considered: rows.length, sent: 0, skipped: 0 }

  for (const row of rows) {
    const daysSince = Math.floor(
      (now.getTime() - row.enrollment.updatedAt.getTime()) / 86_400_000,
    )

    const rendered = nudge({
      firstName: row.contact.firstName,
      dayNumber: row.enrollment.currentDay,
      programSlug: row.program.slug,
      daysSince,
      siteUrl,
    })

    const outcome = await sendToContact({
      db,
      contactId: row.contact.id,
      rendered,
      kind: 'lifecycle',
      templateSlug: 'nudge',
      idempotencyKey: `nudge:${row.enrollment.id}:${row.enrollment.currentDay}`,
    })

    if (outcome.sent) summary.sent++
    else summary.skipped++
  }

  return summary
}

/**
 * The day after Day 7: the Academy invitation.
 *
 * Sent once, the morning after she finishes, in her own timezone. Three
 * things decide whether it goes at all:
 *
 *  - She has to have FINISHED. Not reached Day 7 - finished it.
 *  - It has to be the next day where SHE is, not where the server is.
 *  - She must not already be in the Academy. Selling a woman something she
 *    bought yesterday is the fastest way to make her regret buying it.
 *
 * The opening line depends on who she chose on Day 7, and nothing else does.
 * A woman who consciously chose ME was told that was allowed; an email that
 * congratulated her for choosing HER would take that back.
 */
export async function sendAcademyInvitations(
  db: Db,
  siteUrl: string,
  now = new Date(),
): Promise<JobSummary> {
  const rows = await db
    .select({
      enrollment: enrollments,
      contact: contacts,
      program: programs,
    })
    .from(enrollments)
    .innerJoin(programs, eq(programs.id, enrollments.programId))
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .where(
      and(
        eq(programs.slug, 'me-vs-her'),
        eq(enrollments.status, 'completed'),
        isNull(contacts.archivedAt),
      ),
    )

  const summary: JobSummary = { considered: rows.length, sent: 0, skipped: 0 }

  for (const row of rows) {
    const finishedAt = row.enrollment.completedAt ?? row.enrollment.updatedAt
    const tz = safeTimeZone(row.enrollment.timezoneAtStart)

    // The next day where she is, not where the server is.
    if (localDateKey(now, tz) === localDateKey(finishedAt, tz)) {
      summary.skipped++
      continue
    }
    // And in the morning, not at whatever hour the cron happens to run.
    const hour = localHour(now, tz)
    if (hour < 7 || hour > 11) {
      summary.skipped++
      continue
    }

    /*
     * Already in the Academy? Then this email is not for her.
     *
     * Any active enrollment in a programme that is not the challenge counts:
     * she is already inside, and the invitation would read as a company that
     * does not know who its own customers are.
     */
    const [enrolledElsewhere] = await db
      .select({ id: enrollments.id })
      .from(enrollments)
      .innerJoin(programs, eq(programs.id, enrollments.programId))
      .where(
        and(
          eq(enrollments.contactId, row.contact.id),
          sql`${programs.slug} <> 'me-vs-her'`,
        ),
      )
      .limit(1)

    if (enrolledElsewhere) {
      summary.skipped++
      continue
    }

    /*
     * Who she chose on Day 7. Read from the block response rather than from
     * her_choices, because a woman who chose ME has no row there and the
     * absence of a row must not be mistaken for "she never finished".
     */
    const responses = await db
      .select({ response: blockResponses.response })
      .from(blockResponses)
      .where(eq(blockResponses.enrollmentId, row.enrollment.id))

    const choseHer = responses.some((r) => {
      const value = r.response as { chosen?: unknown } | null
      return value?.chosen === 'her'
    })

    const rendered = academyInvitation({
      firstName: row.contact.firstName,
      choseHer,
      siteUrl,
    })

    const outcome = await sendToContact({
      db,
      contactId: row.contact.id,
      rendered,
      kind: 'lifecycle',
      templateSlug: 'academy-invitation',
      // Once per enrollment, ever.
      idempotencyKey: `academy-invitation:${row.enrollment.id}`,
    })

    if (outcome.sent) summary.sent++
    else summary.skipped++
  }

  return summary
}

/**
 * One email about an order left pending.
 *
 * Deliberately once, ever, per order — the template says so, and the
 * idempotency key makes it true.
 */
export async function sendAbandonedCheckouts(
  db: Db,
  siteUrl: string,
  now = new Date(),
  afterHours = 6,
): Promise<JobSummary> {
  const cutoff = new Date(now.getTime() - afterHours * 3_600_000)
  const floor = new Date(now.getTime() - 7 * 86_400_000)

  const rows = await db
    .select({
      order: orders,
      contact: contacts,
      programTitle: programs.title,
    })
    .from(orders)
    .innerJoin(contacts, eq(contacts.id, orders.contactId))
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .leftJoin(programs, sql`${programs.id} = (
      SELECT program_id FROM offers WHERE offers.id = ${orderItems.offerId}
    )`)
    .where(
      and(
        eq(orders.status, 'pending'),
        lt(orders.placedAt, cutoff),
        // Not the whole back catalogue on the first run of this job.
        sql`${orders.placedAt} > ${floor}`,
        isNull(contacts.archivedAt),
      ),
    )

  const summary: JobSummary = { considered: rows.length, sent: 0, skipped: 0 }

  for (const row of rows) {
    const rendered = abandonedCheckout({
      firstName: row.contact.firstName,
      programTitle: row.programTitle ?? 'the Divine Feminine',
      siteUrl,
    })

    const outcome = await sendToContact({
      db,
      contactId: row.contact.id,
      rendered,
      kind: 'lifecycle',
      templateSlug: 'abandoned-checkout',
      idempotencyKey: `abandoned:${row.order.id}`,
    })

    if (outcome.sent) summary.sent++
    else summary.skipped++
  }

  return summary
}

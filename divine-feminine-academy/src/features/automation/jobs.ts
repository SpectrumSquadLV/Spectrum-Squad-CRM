import 'server-only'

import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
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
import { abandonedCheckout, dayReminder, nudge } from '@/features/email/templates'

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
    })
    .from(enrollments)
    .innerJoin(programs, eq(programs.id, enrollments.programId))
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .leftJoin(profiles, eq(profiles.contactId, enrollments.contactId))
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

    const unlock = computeUnlockState({
      pacing: row.program.pacing as Pacing,
      startedAt: row.enrollment.startedAt,
      now,
      timeZone,
      durationDays,
      allowEarlyUnlock: row.program.allowEarlyUnlock,
      highestCompletedDay: Number(completedAgg?.day ?? 0),
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
      programTitle: row.programTitle ?? 'the Academy',
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

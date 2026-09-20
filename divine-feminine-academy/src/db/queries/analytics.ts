import 'server-only'

import { and, desc, eq, gte, sql } from 'drizzle-orm'
import {
  activityEvents,
  contacts,
  enrollments,
  herChoices,
  lessonProgress,
  lessons,
  modules,
  orders,
  programVersions,
  programs,
} from '../schema'
import { policy, require_ } from '@/lib/permissions/policy'
import type { QueryContext } from './_context'

/**
 * The funnel.
 *
 * Every number here is a query over `activity_events` or the tables it points
 * at. That was the point of writing an event row for every meaningful action
 * from Phase 1: analytics is a reporting problem, not an instrumentation
 * scramble six months in.
 *
 * Nothing in this file reads journal content. Engagement is counted; words are
 * not available to count.
 */

export interface FunnelStep {
  label: string
  count: number
  /** Percentage of the step above. Null for the first step. */
  conversionFromPrevious: number | null
}

const pct = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((part / whole) * 100)

export async function getFunnel(
  { db, actor }: QueryContext,
  sinceDays = 90,
): Promise<FunnelStep[]> {
  require_(policy.admin.viewPipeline(actor))
  const since = new Date(Date.now() - sinceDays * 86_400_000)

  const [row] = await db
    .select({
      leads: sql<number>`(SELECT count(*) FROM ${contacts} WHERE ${contacts.leadAt} >= ${since})`,
      assessments: sql<number>`(
        SELECT count(DISTINCT ${activityEvents.contactId}) FROM ${activityEvents}
        WHERE ${activityEvents.eventType} = 'assessment.completed'
          AND ${activityEvents.occurredAt} >= ${since}
      )`,
      started: sql<number>`(
        SELECT count(DISTINCT ${activityEvents.contactId}) FROM ${activityEvents}
        WHERE ${activityEvents.eventType} = 'challenge.started'
          AND ${activityEvents.occurredAt} >= ${since}
      )`,
      completed: sql<number>`(
        SELECT count(DISTINCT ${activityEvents.contactId}) FROM ${activityEvents}
        WHERE ${activityEvents.eventType} = 'challenge.completed'
          AND ${activityEvents.occurredAt} >= ${since}
      )`,
      checkoutStarted: sql<number>`(
        SELECT count(DISTINCT ${activityEvents.contactId}) FROM ${activityEvents}
        WHERE ${activityEvents.eventType} = 'checkout.started'
          AND ${activityEvents.occurredAt} >= ${since}
      )`,
      paid: sql<number>`(
        SELECT count(DISTINCT ${orders.contactId}) FROM ${orders}
        WHERE ${orders.status} = 'paid' AND ${orders.paidAt} >= ${since}
      )`,
    })
    .from(sql`(SELECT 1) AS one`)

  const leads = Number(row?.leads ?? 0)
  const assessments = Number(row?.assessments ?? 0)
  const started = Number(row?.started ?? 0)
  const completed = Number(row?.completed ?? 0)
  const checkoutStarted = Number(row?.checkoutStarted ?? 0)
  const paid = Number(row?.paid ?? 0)

  return [
    { label: 'Leads', count: leads, conversionFromPrevious: null },
    {
      label: 'Took the assessment',
      count: assessments,
      conversionFromPrevious: pct(assessments, leads),
    },
    {
      label: 'Started the challenge',
      count: started,
      conversionFromPrevious: pct(started, leads),
    },
    {
      label: 'Finished it',
      count: completed,
      conversionFromPrevious: pct(completed, started),
    },
    {
      label: 'Started checkout',
      count: checkoutStarted,
      conversionFromPrevious: pct(checkoutStarted, completed),
    },
    { label: 'Paid', count: paid, conversionFromPrevious: pct(paid, checkoutStarted) },
  ]
}

export interface DayDropOff {
  day: number
  title: string
  reached: number
  completed: number
  /** How many stopped here and did not finish the next day. */
  lostHere: number
}

/**
 * Where women stall.
 *
 * The single most useful number in the business: if half of them stop on Day
 * 2, Day 2 is the problem, and no amount of traffic fixes it.
 */
export async function getDayDropOff(
  { db, actor }: QueryContext,
  programSlug: string,
): Promise<DayDropOff[]> {
  require_(policy.admin.viewPipeline(actor))

  // Resolve the current version first, then query its days. Expressing this
  // as one clever join produced SQL that was hard to read and easy to get
  // subtly wrong; two plain queries are obviously correct.
  const [version] = await db
    .select({ id: programVersions.id })
    .from(programVersions)
    .innerJoin(programs, eq(programs.id, programVersions.programId))
    .where(eq(programs.slug, programSlug))
    .orderBy(desc(programVersions.version))
    .limit(1)

  if (!version) return []

  const rows = await db
    .select({
      day: modules.position,
      title: modules.title,
      completed: sql<number>`count(DISTINCT ${lessonProgress.enrollmentId}) FILTER (
        WHERE ${lessonProgress.status} = 'completed'
      )`,
    })
    .from(modules)
    .innerJoin(lessons, eq(lessons.moduleId, modules.id))
    .leftJoin(lessonProgress, eq(lessonProgress.lessonId, lessons.id))
    .where(eq(modules.versionId, version.id))
    .groupBy(modules.position, modules.title)
    .orderBy(modules.position)

  return rows.map((row, i) => {
    const completed = Number(row.completed)
    const previous = i === 0 ? completed : Number(rows[i - 1]?.completed ?? 0)
    const next = Number(rows[i + 1]?.completed ?? 0)
    return {
      day: row.day,
      title: row.title,
      reached: previous,
      completed,
      // How many finished this day and never finished the next one.
      lostHere: Math.max(0, completed - next),
    }
  })
}

export interface Headline {
  label: string
  value: string
  note?: string
}

export async function getHeadlines(
  { db, actor }: QueryContext,
  sinceDays = 30,
): Promise<Headline[]> {
  require_(policy.admin.viewPipeline(actor))
  const since = new Date(Date.now() - sinceDays * 86_400_000)

  const [row] = await db
    .select({
      newContacts: sql<number>`(SELECT count(*) FROM ${contacts} WHERE ${contacts.leadAt} >= ${since})`,
      activeEnrollments: sql<number>`(
        SELECT count(*) FROM ${enrollments} WHERE ${enrollments.status} = 'active'
      )`,
      completions: sql<number>`(
        SELECT count(*) FROM ${enrollments} WHERE ${enrollments.status} = 'completed'
      )`,
      revenueCents: sql<number>`(
        SELECT coalesce(sum(${orders.totalCents}), 0) FROM ${orders}
        WHERE ${orders.status} = 'paid' AND ${orders.paidAt} >= ${since}
      )`,
      choices: sql<number>`(
        SELECT count(*) FROM ${herChoices} WHERE ${herChoices.occurredAt} >= ${since}
      )`,
      stalled: sql<number>`(
        SELECT count(*) FROM ${enrollments}
        WHERE ${enrollments.status} = 'active'
          AND ${enrollments.updatedAt} < now() - interval '3 days'
      )`,
    })
    .from(sql`(SELECT 1) AS one`)

  const revenue = Number(row?.revenueCents ?? 0)

  return [
    { label: 'New contacts', value: String(Number(row?.newContacts ?? 0)), note: `last ${sinceDays} days` },
    { label: 'Active now', value: String(Number(row?.activeEnrollments ?? 0)) },
    { label: 'Stalled 3+ days', value: String(Number(row?.stalled ?? 0)), note: 'nudged automatically' },
    { label: 'Completions', value: String(Number(row?.completions ?? 0)), note: 'all time' },
    {
      label: 'Revenue',
      value: new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
      }).format(revenue / 100),
      note: `last ${sinceDays} days`,
    },
    { label: 'HER choices', value: String(Number(row?.choices ?? 0)), note: `last ${sinceDays} days` },
  ]
}

/** Where women are coming from. */
export async function getSources(
  { db, actor }: QueryContext,
  sinceDays = 90,
) {
  require_(policy.admin.viewPipeline(actor))
  const since = new Date(Date.now() - sinceDays * 86_400_000)

  const rows = await db
    .select({
      source: sql<string>`coalesce(${contacts.acquisitionSource}, 'unknown')`,
      count: sql<number>`count(*)`,
      paid: sql<number>`count(*) FILTER (WHERE ${contacts.lifetimeValueCents} > 0)`,
    })
    .from(contacts)
    .where(gte(contacts.leadAt, since))
    .groupBy(sql`coalesce(${contacts.acquisitionSource}, 'unknown')`)
    .orderBy(sql`count(*) desc`)
    .limit(12)

  return rows.map((r) => ({
    source: r.source,
    count: Number(r.count),
    paid: Number(r.paid),
    conversion: pct(Number(r.paid), Number(r.count)),
  }))
}

/** Programmes with an active enrollment, for the drop-off picker. */
export async function listActiveProgramSlugs({ db, actor }: QueryContext) {
  require_(policy.admin.viewPipeline(actor))
  return db
    .select({ slug: programs.slug, title: programs.title })
    .from(programs)
    .where(and(eq(programs.status, 'published')))
    .orderBy(programs.title)
}

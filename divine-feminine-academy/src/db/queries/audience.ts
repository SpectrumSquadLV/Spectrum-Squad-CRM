import 'server-only'

import { and, count, desc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm'
import { contactTags, contacts, tags } from '../schema/identity'
import { activityEvents, emailEvents } from '../schema/activity'
import type { QueryContext } from './_context'

/**
 * WHO IS ON THE LIST, AND WHERE THEY CAME FROM.
 *
 * Every read here excludes archived contacts, because an archived woman is not
 * on anybody's list and counting her would quietly inflate every number on the
 * page.
 *
 * "Reachable" is the number that matters, and it is deliberately stricter than
 * "has an email address": it excludes women who unsubscribed and women whose
 * address has bounced or complained. A list size that counts people you can no
 * longer write to is a vanity number, and it is the one that makes a send look
 * like it failed when it did exactly what it should.
 */

export interface AudienceTotals {
  everybody: number
  reachable: number
  unsubscribed: number
  bounced: number
  addedLast7Days: number
  addedLast30Days: number
}

const notArchived = isNull(contacts.archivedAt)

export async function audienceTotals(
  db: QueryContext['db'],
  now = new Date(),
): Promise<AudienceTotals> {
  /*
   * ISO strings with an explicit cast, not Date objects.
   *
   * A Date interpolated into a raw SQL fragment is handed to the driver as an
   * object it cannot bind, and the query fails at runtime rather than at
   * compile time — which is the worst place for it to fail.
   */
  const since = (days: number) =>
    new Date(now.getTime() - days * 86_400_000).toISOString()

  const [row] = await db
    .select({
      everybody: count(),
      unsubscribed: sql<number>`count(*) filter (where ${contacts.emailOptedOutAt} is not null)::int`,
      addedLast7Days: sql<number>`count(*) filter (where ${contacts.leadAt} >= ${since(7)}::timestamptz)::int`,
      addedLast30Days: sql<number>`count(*) filter (where ${contacts.leadAt} >= ${since(30)}::timestamptz)::int`,
    })
    .from(contacts)
    .where(notArchived)

  const [bouncedRow] = await db
    .select({ n: sql<number>`count(distinct ${emailEvents.contactId})::int` })
    .from(emailEvents)
    .innerJoin(contacts, eq(contacts.id, emailEvents.contactId))
    .where(
      and(notArchived, sql`${emailEvents.type} in ('bounced', 'complained')`),
    )

  const everybody = Number(row?.everybody ?? 0)
  const unsubscribed = Number(row?.unsubscribed ?? 0)
  const bounced = Number(bouncedRow?.n ?? 0)

  return {
    everybody,
    // Bounced and unsubscribed can overlap, so this is a floor rather than a
    // subtraction of two independent numbers.
    reachable: Math.max(0, everybody - unsubscribed - bounced),
    unsubscribed,
    bounced,
    addedLast7Days: Number(row?.addedLast7Days ?? 0),
    addedLast30Days: Number(row?.addedLast30Days ?? 0),
  }
}

export interface SourceCount {
  source: string | null
  total: number
  unsubscribed: number
  last30Days: number
}

/** Every way somebody has arrived, commonest first. */
export async function countsBySource(
  db: QueryContext['db'],
  now = new Date(),
): Promise<SourceCount[]> {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString()

  const rows = await db
    .select({
      source: contacts.acquisitionSource,
      total: count(),
      unsubscribed: sql<number>`count(*) filter (where ${contacts.emailOptedOutAt} is not null)::int`,
      last30Days: sql<number>`count(*) filter (where ${contacts.leadAt} >= ${since}::timestamptz)::int`,
    })
    .from(contacts)
    .where(notArchived)
    .groupBy(contacts.acquisitionSource)
    .orderBy(desc(count()))

  return rows.map((r) => ({
    source: r.source,
    total: Number(r.total),
    unsubscribed: Number(r.unsubscribed),
    last30Days: Number(r.last30Days),
  }))
}

export interface TagCount {
  slug: string
  name: string
  total: number
}

/** What she has been tagged with — archetypes, the letters list, waitlists. */
export async function countsByTag(
  db: QueryContext['db'],
): Promise<TagCount[]> {
  const rows = await db
    .select({ slug: tags.slug, name: tags.name, total: count() })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .innerJoin(contacts, eq(contacts.id, contactTags.contactId))
    .where(notArchived)
    .groupBy(tags.slug, tags.name)
    .orderBy(desc(count()))

  return rows.map((r) => ({ slug: r.slug, name: r.name, total: Number(r.total) }))
}

export interface RecentOptIn {
  contactId: string
  firstName: string | null
  email: string
  source: string | null
  joinedAt: Date
  unsubscribed: boolean
}

/**
 * The most recent arrivals.
 *
 * Deliberately shows the email address: this is the owner's own list, on a
 * staff-only page, and being unable to see who just signed up would make the
 * page useless. Nothing here reads anything she WROTE - no journal, no
 * answers, no quiz responses. Just that she arrived and where from.
 */
export async function recentOptIns(
  db: QueryContext['db'],
  limit = 50,
): Promise<RecentOptIn[]> {
  const rows = await db
    .select({
      contactId: contacts.id,
      firstName: contacts.firstName,
      email: contacts.email,
      source: contacts.acquisitionSource,
      joinedAt: contacts.leadAt,
      optedOut: contacts.emailOptedOutAt,
    })
    .from(contacts)
    .where(notArchived)
    .orderBy(desc(contacts.leadAt))
    .limit(limit)

  return rows.map((r) => ({
    contactId: r.contactId,
    firstName: r.firstName,
    email: r.email,
    source: r.source,
    joinedAt: r.joinedAt,
    unsubscribed: r.optedOut !== null,
  }))
}

export interface OptInEvent {
  eventType: string
  total: number
  last30Days: number
}

/**
 * Opt-ins counted from the EVENT log rather than from the contact.
 *
 * These answer a different question. `acquisitionSource` is where she came
 * from the FIRST time and never changes; these are every moment she chose to
 * hear from you, including the ones after she was already on the list. A woman
 * who found you through the quiz and later subscribed from an article appears
 * once in the source table and twice here, and both are correct.
 */
export async function optInEvents(
  db: QueryContext['db'],
  now = new Date(),
): Promise<OptInEvent[]> {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const wanted = [
    'quiz.completed',
    'archetype.assigned',
    'writing.subscribed',
    'cohort.waitlisted',
    'assessment.completed',
    'email.unsubscribed',
  ]

  const rows = await db
    .select({
      eventType: activityEvents.eventType,
      total: count(),
      last30Days: sql<number>`count(*) filter (where ${activityEvents.occurredAt} >= ${since}::timestamptz)::int`,
    })
    .from(activityEvents)
    .where(
      and(
        isNotNull(activityEvents.contactId),
        inArray(activityEvents.eventType, wanted),
      ),
    )
    .groupBy(activityEvents.eventType)
    .orderBy(desc(count()))

  return rows.map((r) => ({
    eventType: r.eventType,
    total: Number(r.total),
    last30Days: Number(r.last30Days),
  }))
}

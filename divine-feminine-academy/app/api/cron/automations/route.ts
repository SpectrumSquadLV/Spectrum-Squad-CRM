import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/db/client'
import { runDue, sweepEventsForAutomation } from '@/features/automation/runner'
import {
  sendAbandonedCheckouts,
  sendDayReminders,
  sendStallNudges,
} from '@/features/automation/jobs'
import { sendToContact } from '@/features/email/send'
import { runArchetypeRule } from '@/features/quiz/sequence-send'
import { announceNewWriting } from '@/features/writing/announce'
import { syncFeed } from '@/features/podcast/sync'
import { templates } from '@/features/email/templates'
import { siteUrl } from '@/lib/auth/env'

/**
 * The scheduled runner. Call it hourly.
 *
 * Public URL, so it is protected by a shared secret. Everything it does is
 * idempotent, which means running it twice in the same hour — or having two
 * invocations overlap — is safe.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  // No secret configured means the endpoint stays shut. Failing open here
  // would let anybody trigger every email in the system.
  if (!expected) return false

  const header =
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    new URL(request.url).searchParams.get('secret') ??
    ''

  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Carries out a `send_email` automation.
 *
 * The rule names a template; anything it does not recognise is a no-op rather
 * than a crash, so a mistyped rule cannot stop the whole queue.
 */
async function sendEmailAction({
  contactId,
  rule,
}: {
  contactId: string
  rule: { actionConfig: Record<string, unknown>; name: string }
}) {
  // The archetype sequences are the main thing rules drive, and they carry
  // everything they need in the rule itself.
  if (
    await runArchetypeRule({
      db,
      contactId,
      actionConfig: rule.actionConfig,
      siteUrl: siteUrl(),
    })
  ) {
    return
  }

  const name = String(rule.actionConfig.template ?? '')
  if (!(name in templates)) return

  // Of the rest, only the templates that need nothing but a name can be driven
  // from a rule; the others are sent by the job that has their context.
  if (name !== 'nudge') return

  const rendered = templates.nudge({
    firstName: null,
    dayNumber: Number(rule.actionConfig.dayNumber ?? 1),
    programSlug: String(rule.actionConfig.programSlug ?? 'me-vs-her'),
    daysSince: 0,
    siteUrl: siteUrl(),
  })

  await sendToContact({
    db,
    contactId,
    rendered,
    kind: 'lifecycle',
    templateSlug: name,
    idempotencyKey: `rule:${rule.name}:${contactId}`,
  })
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  const now = new Date()
  const url = siteUrl()

  /*
   * Sweep first, then run.
   *
   * The sweep turns recent activity events into scheduled runs; `runDue`
   * executes the ones whose time has come. In that order, an event written
   * minutes ago with a zero delay goes out in this same invocation instead of
   * waiting another hour.
   */
  const swept = await sweepEventsForAutomation(db, now)

  /*
   * Pull the podcast feed BEFORE announcing anything.
   *
   * In this order an episode that went live on RSS.com half an hour ago is
   * imported and then announced in the same invocation. The other way round
   * it would sit unannounced for an hour, and if that hour crossed the
   * announce job's 72-hour freshness window it would never be announced at
   * all.
   *
   * The first sync imports the entire back catalogue. That is safe for the
   * same reason: everything older than 72 hours is marked announced without
   * being sent, so importing a hundred episodes cannot mail the list a
   * hundred times.
   *
   * It is awaited on its own rather than in the Promise.all below, because
   * the announce job has to see what it wrote.
   */
  let podcast
  try {
    podcast = await syncFeed(db, {})
  } catch (error) {
    // The show lives on somebody else's server. An outage there must not stop
    // the day reminders, the nudges or the abandoned checkouts.
    console.error('[cron] podcast sync failed', error)
    podcast = { error: error instanceof Error ? error.message : 'sync failed' }
  }

  const [automations, reminders, nudges, abandoned, writing] = await Promise.all([
    runDue(db, {
      send_email: (ctx) => sendEmailAction(ctx),
    }, now),
    sendDayReminders(db, url, now),
    sendStallNudges(db, url, now),
    sendAbandonedCheckouts(db, url, now),
    announceNewWriting(db, url, now),
  ])

  return NextResponse.json({
    ranAt: now.toISOString(),
    swept,
    podcast,
    automations,
    reminders,
    nudges,
    abandoned,
    writing,
  })
}

/** GET so a scheduler that only issues GETs can drive it too. */
export async function GET(request: Request) {
  return POST(request)
}

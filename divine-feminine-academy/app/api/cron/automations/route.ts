import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/db/client'
import { runDue } from '@/features/automation/runner'
import {
  sendAbandonedCheckouts,
  sendDayReminders,
  sendStallNudges,
} from '@/features/automation/jobs'
import { sendToContact } from '@/features/email/send'
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
  const name = String(rule.actionConfig.template ?? '')
  if (!(name in templates)) return

  // Only the templates that need nothing but a name can be driven from a rule;
  // the rest are sent by the job that has the context they need.
  if (name !== 'nudge') return

  const rendered = templates.nudge({
    firstName: null,
    dayNumber: Number(rule.actionConfig.dayNumber ?? 1),
    programSlug: String(rule.actionConfig.programSlug ?? '7-days-to-her'),
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

  const [automations, reminders, nudges, abandoned] = await Promise.all([
    runDue(db, {
      send_email: (ctx) => sendEmailAction(ctx),
    }, now),
    sendDayReminders(db, url, now),
    sendStallNudges(db, url, now),
    sendAbandonedCheckouts(db, url, now),
  ])

  return NextResponse.json({
    ranAt: now.toISOString(),
    automations,
    reminders,
    nudges,
    abandoned,
  })
}

/** GET so a scheduler that only issues GETs can drive it too. */
export async function GET(request: Request) {
  return POST(request)
}

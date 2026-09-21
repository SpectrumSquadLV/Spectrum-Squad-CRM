import 'server-only'

import { eq } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { activityEvents } from '@/db/schema/activity'
import { contacts } from '@/db/schema/identity'
import { sendToContact, type SendOutcome } from '@/features/email/send'
import { archetypeSequence } from '@/features/email/templates'
import { unsubscribeUrl } from '@/lib/email/unsubscribe'
import { isMode, type ProtectiveMode } from './archetypes'
import { sequenceStep } from './sequences'

/**
 * Send one step of one archetype sequence to one woman.
 *
 * ONE function for both entry points. Step 1 is sent straight away by
 * whichever path she came in through — the quiz or the opt-in form — because
 * "check your inbox" followed by an hour of nothing is a broken promise, and
 * the hourly job is the only other clock we have. Steps 2 to 5 are sent by the
 * automation engine on a delay.
 *
 * The idempotency key is (archetype, step, contact), so it does not matter how
 * many times this is called or from where: she receives each email once. If
 * she retakes the quiz and comes out as somebody else, that is a DIFFERENT
 * archetype and therefore a different key, so she gets the new sequence — which
 * is right, because it is a different set of words about a different version
 * of her.
 */
export async function sendArchetypeStep(input: {
  db: Db
  contactId: string
  mode: ProtectiveMode
  step: number
  siteUrl: string
}): Promise<SendOutcome> {
  const { db, contactId, mode, step, siteUrl } = input

  const email = sequenceStep(mode, step)
  if (!email) return { sent: false, reason: 'no-contact' }

  const [contact] = await db
    .select({ firstName: contacts.firstName })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1)

  if (!contact) return { sent: false, reason: 'no-contact' }

  const rendered = archetypeSequence({
    firstName: contact.firstName,
    email,
    siteUrl,
    unsubscribeUrl: unsubscribeUrl(siteUrl, contactId),
  })

  const outcome = await sendToContact({
    db,
    contactId,
    rendered,
    kind: 'lifecycle',
    templateSlug: `archetype-${mode}-${step}`,
    idempotencyKey: `archetype:${mode}:${step}:${contactId}`,
  })

  if (outcome.sent) {
    await db.insert(activityEvents).values({
      contactId,
      eventType: 'sequence.email_sent',
      entity: 'email_events',
      metadata: { archetype: mode, step, subject: rendered.subject },
    })
  }

  return outcome
}

/**
 * Carry out a `send_email` automation rule that names an archetype step.
 *
 * Returns false when the rule is not one of ours, so the caller can fall
 * through to its other templates.
 */
export async function runArchetypeRule(input: {
  db: Db
  contactId: string
  actionConfig: Record<string, unknown>
  siteUrl: string
}): Promise<boolean> {
  if (String(input.actionConfig.template ?? '') !== 'archetypeSequence') {
    return false
  }

  const mode = String(input.actionConfig.archetype ?? '')
  const step = Number(input.actionConfig.step ?? 0)

  // A mistyped rule is a no-op rather than a crash: one bad row must not stop
  // the whole queue for everybody else.
  if (!isMode(mode) || !Number.isInteger(step) || step < 1) return true

  await sendArchetypeStep({
    db: input.db,
    contactId: input.contactId,
    mode,
    step,
    siteUrl: input.siteUrl,
  })
  return true
}

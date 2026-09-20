import 'server-only'

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { activityEvents, contacts, emailEvents, profiles } from '@/db/schema'
import { emailProvider } from '@/lib/email'
import type { RenderedEmail } from './templates'

/**
 * Sending an email to a contact.
 *
 * Everything goes through here, so the rules below are impossible to forget:
 *
 *   - A woman who turned reminders off does not get reminders. Transactional
 *     mail (her sign-in link, her receipt) ignores that preference, because
 *     switching off marketing must not lock her out of her own account.
 *   - A bounced or complained address is never written to again. Continuing to
 *     mail a complaint is how a sending domain dies.
 *   - Every send is recorded, and an idempotency key means a retried
 *     automation cannot post the same email twice.
 */

export type EmailKind = 'transactional' | 'lifecycle'

export interface SendToContactInput {
  db: Db
  contactId: string
  rendered: RenderedEmail
  kind: EmailKind
  /** Stable per (contact, purpose) so a retry is a no-op. */
  idempotencyKey: string
  templateSlug?: string
}

export type SendOutcome =
  | { sent: true; messageId: string }
  | { sent: false; reason: 'no-contact' | 'suppressed' | 'opted-out' | 'duplicate' | 'failed' }

/**
 * True when this address has bounced or complained.
 *
 * Only the provider's own webhooks write these rows. Our own send failures are
 * recorded elsewhere, precisely so a transient error cannot suppress a woman's
 * address permanently.
 */
export async function isSuppressed(db: Db, contactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: emailEvents.id })
    .from(emailEvents)
    .where(
      and(
        eq(emailEvents.contactId, contactId),
        sql`${emailEvents.type} IN ('bounced', 'complained')`,
      ),
    )
    .limit(1)
  return Boolean(row)
}

async function alreadySent(db: Db, key: string): Promise<boolean> {
  const [row] = await db
    .select({ id: emailEvents.id })
    .from(emailEvents)
    .where(
      and(
        eq(emailEvents.type, 'sent'),
        sql`${emailEvents.metadata}->>'idempotencyKey' = ${key}`,
      ),
    )
    .limit(1)
  return Boolean(row)
}

export async function sendToContact(
  input: SendToContactInput,
): Promise<SendOutcome> {
  const { db, contactId, rendered, kind, idempotencyKey } = input

  const [contact] = await db
    .select({
      email: contacts.email,
      archivedAt: contacts.archivedAt,
      emailOptedOutAt: contacts.emailOptedOutAt,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1)

  if (!contact || contact.archivedAt) return { sent: false, reason: 'no-contact' }

  if (await isSuppressed(db, contactId)) return { sent: false, reason: 'suppressed' }

  if (kind === 'lifecycle') {
    /*
     * She clicked unsubscribe.
     *
     * Checked BEFORE the profile preference, because this is the one a lead
     * has: a woman who joined an archetype sequence from a shared link has no
     * auth user and therefore no profile row, and the old check would have
     * silently kept mailing her forever.
     */
    if (contact.emailOptedOutAt) return { sent: false, reason: 'opted-out' }

    const [profile] = await db
      .select({ prefs: profiles.notificationPrefs })
      .from(profiles)
      .where(eq(profiles.contactId, contactId))
      .limit(1)

    const prefs = (profile?.prefs ?? {}) as { dailyEmail?: boolean }
    // Absent means she has not chosen; default to sending, which is what she
    // signed up for. An explicit false is honoured.
    if (prefs.dailyEmail === false) return { sent: false, reason: 'opted-out' }
  }

  if (await alreadySent(db, idempotencyKey)) {
    return { sent: false, reason: 'duplicate' }
  }

  try {
    const result = await emailProvider().send({
      to: contact.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey,
      tags: { kind, ...(input.templateSlug ? { template: input.templateSlug } : {}) },
    })

    await db.insert(emailEvents).values({
      contactId,
      providerMessageId: result.messageId,
      type: 'sent',
      metadata: {
        idempotencyKey,
        kind,
        subject: rendered.subject,
        template: input.templateSlug ?? null,
      },
    })

    return { sent: true, messageId: result.messageId }
  } catch {
    /*
     * Recorded as an ACTIVITY event, not an email event.
     *
     * A failure here is our send call failing - a network blip, a rate limit -
     * not the address rejecting mail. Writing it to `email_events` as a bounce
     * would make `isSuppressed` true forever and silently cut her off from her
     * own sign-in links over one transient error.
     *
     * Only the provider's own bounce and complaint webhooks suppress an
     * address. And this deliberately does not write a 'sent' row, so the
     * idempotency key stays free for a retry.
     */
    await db.insert(activityEvents).values({
      contactId,
      eventType: 'email.send_failed',
      entity: 'email_events',
      metadata: { idempotencyKey, kind, subject: rendered.subject },
    })
    return { sent: false, reason: 'failed' }
  }
}

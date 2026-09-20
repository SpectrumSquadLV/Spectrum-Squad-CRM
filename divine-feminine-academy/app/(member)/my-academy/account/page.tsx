import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts, profiles } from '@/db/schema'
import { Card, CardBody, CardTitle, Rule } from '@/design-system/primitives'
import { Eyebrow, Placeholder, Prose } from '@/design-system/patterns'
import { AccountForm } from '@/features/account/AccountForm'
import { getActor } from '@/lib/auth/actor-server'

export const metadata: Metadata = { title: 'Account' }

export default async function AccountPage() {
  const actor = await getActor()

  if (actor.kind !== 'user' || !actor.contactId) {
    // Middleware already gates this route; this is the belt to its braces.
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 md:px-8">
        <h1 className="text-2xl">Account</h1>
        <Prose className="mt-4">
          <p>We could not find your account. Try signing in again.</p>
        </Prose>
      </div>
    )
  }

  const [contact] = await db
    .select({
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      timezone: contacts.timezone,
    })
    .from(contacts)
    .where(eq(contacts.id, actor.contactId))
    .limit(1)

  const [profile] = await db
    .select({ notificationPrefs: profiles.notificationPrefs })
    .from(profiles)
    .where(eq(profiles.contactId, actor.contactId))
    .limit(1)

  const prefs = (profile?.notificationPrefs ?? {}) as {
    dailyEmail?: boolean
    reminderHour?: number
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-12 md:px-8 md:py-16">
      <Eyebrow>Account</Eyebrow>
      <h1 className="mt-4 text-2xl">Your details</h1>

      <AccountForm
        className="mt-10"
        firstName={contact?.firstName ?? ''}
        lastName={contact?.lastName ?? ''}
        email={contact?.email ?? ''}
        timezone={contact?.timezone ?? 'America/Los_Angeles'}
        dailyEmail={prefs.dailyEmail ?? true}
        reminderHour={prefs.reminderHour ?? 8}
      />

      <Rule tone="gilt" className="my-14" />

      <Card tone="sunken">
        <CardTitle className="text-lg">Your journal</CardTitle>
        <CardBody className="text-xs">
          Encrypted with a key belonging to your account. Nobody who works here
          can read it — not support, not the founder. If you delete your
          account we destroy that key, and every entry becomes permanently
          unreadable.
        </CardBody>
      </Card>

      <Placeholder
        label="Not built yet"
        note="export and delete"
        className="mt-8"
      >
        <Prose className="text-sm">
          <p>
            Downloading everything you have written, and deleting your account
            for good, both belong here. The encryption model already makes
            deletion meaningful — destroying the key is the deletion — but the
            buttons and the confirmation flow are Phase 6.
          </p>
        </Prose>
      </Placeholder>

      <Placeholder label="Not built yet" note="billing" className="mt-6">
        <p className="text-xs text-ink-soft">
          Purchases, payment plans and receipts appear here once checkout exists
          in Phase 5.
        </p>
      </Placeholder>
    </div>
  )
}

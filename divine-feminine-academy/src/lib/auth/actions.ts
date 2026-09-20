'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/db/client'
import { activityEvents, contacts, crmStages, profiles } from '@/db/schema'
import { siteUrl } from './env'
import { createServerSupabase } from './server'

/**
 * Sign-up and sign-in.
 *
 * There is deliberately no password at sign-up. A woman arriving from a reel
 * gives her first name and email and is sent a magic link; password friction
 * at that moment costs conversions. She can set one later from her account.
 */

const joinSchema = z.object({
  firstName: z.string().trim().min(1, 'Tell us what to call you.').max(80),
  email: z.string().trim().toLowerCase().email('That address does not look right.'),
  timezone: z.string().trim().min(1).max(64).default('America/Los_Angeles'),
  source: z.string().trim().max(120).optional(),
  utmSource: z.string().trim().max(120).optional(),
  utmMedium: z.string().trim().max(120).optional(),
  utmCampaign: z.string().trim().max(120).optional(),
  next: z.string().trim().max(200).optional(),
})

export type AuthFormState = { error?: string; fieldErrors?: Record<string, string> }

function readForm(formData: FormData) {
  return Object.fromEntries(formData.entries())
}

/**
 * Create (or find) the contact, then send a magic link.
 *
 * The contact row is created BEFORE the auth user exists. A lead and a member
 * are the same woman at different moments, so she is a contact from the moment
 * she gives an email, whether or not she ever logs in.
 */
export async function join(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = joinSchema.safeParse(readForm(formData))
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      if (typeof key === 'string' && !fieldErrors[key]) {
        fieldErrors[key] = issue.message
      }
    }
    return { fieldErrors }
  }

  const input = parsed.data

  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, input.email))
    .limit(1)

  let contactId = existing?.id

  if (!contactId) {
    const [defaultStage] = await db
      .select({ id: crmStages.id })
      .from(crmStages)
      .where(eq(crmStages.isDefault, true))
      .limit(1)

    const [created] = await db
      .insert(contacts)
      .values({
        firstName: input.firstName,
        email: input.email,
        timezone: input.timezone,
        acquisitionSource: input.source ?? null,
        utmSource: input.utmSource ?? null,
        utmMedium: input.utmMedium ?? null,
        utmCampaign: input.utmCampaign ?? null,
        crmStageId: defaultStage?.id ?? null,
        lastActivityAt: new Date(),
      })
      .returning({ id: contacts.id })

    contactId = created?.id
  }

  if (contactId) {
    await db.insert(activityEvents).values({
      contactId,
      eventType: existing ? 'auth.link_requested' : 'contact.created',
      entity: 'contacts',
      entityId: contactId,
      metadata: { source: input.source ?? null },
    })
  }

  const supabase = await createServerSupabase()
  const { error } = await supabase.auth.signInWithOtp({
    email: input.email,
    options: {
      emailRedirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent(
        input.next ?? '/my-academy',
      )}`,
      data: { first_name: input.firstName, timezone: input.timezone },
    },
  })

  if (error) return { error: error.message }

  redirect(`/check-email?email=${encodeURIComponent(input.email)}`)
}

const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email('That address does not look right.'),
  next: z.string().trim().max(200).optional(),
})

export async function signInWithLink(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse(readForm(formData))
  if (!parsed.success) {
    return { fieldErrors: { email: 'That address does not look right.' } }
  }

  const supabase = await createServerSupabase()
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      // Do NOT create an account from the sign-in form. Signing up is a
      // separate, deliberate act with a name attached.
      shouldCreateUser: false,
      emailRedirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent(
        parsed.data.next ?? '/my-academy',
      )}`,
    },
  })

  if (error) return { error: error.message }

  redirect(`/check-email?email=${encodeURIComponent(parsed.data.email)}`)
}

export async function signOut() {
  const supabase = await createServerSupabase()
  await supabase.auth.signOut()
  revalidatePath('/', 'layout')
  redirect('/')
}

/**
 * Link the authenticated user to her contact row.
 *
 * Runs after a magic link is exchanged. Idempotent: safe on every sign-in.
 */
export async function linkUserToContact(
  userId: string,
  email: string,
  firstName?: string,
  timezone?: string,
) {
  const normalized = email.trim().toLowerCase()

  const [contact] = await db
    .select({ id: contacts.id, userId: contacts.userId })
    .from(contacts)
    .where(eq(contacts.email, normalized))
    .limit(1)

  let contactId = contact?.id

  if (!contactId) {
    const [created] = await db
      .insert(contacts)
      .values({
        email: normalized,
        firstName: firstName ?? null,
        timezone: timezone ?? 'America/Los_Angeles',
        userId,
        lastActivityAt: new Date(),
      })
      .returning({ id: contacts.id })
    contactId = created?.id
  } else if (!contact?.userId) {
    await db
      .update(contacts)
      .set({ userId, lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(contacts.id, contactId))
  }

  if (!contactId) return

  const [existingProfile] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1)

  if (!existingProfile) {
    await db.insert(profiles).values({
      userId,
      contactId,
      displayName: firstName ?? null,
      notificationPrefs: { dailyEmail: true, reminderHour: 8 },
    })
  }
}

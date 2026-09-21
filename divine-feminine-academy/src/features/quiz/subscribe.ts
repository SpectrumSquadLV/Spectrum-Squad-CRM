import 'server-only'

import { z } from 'zod'
import { db } from '@/db/client'
import { activityEvents } from '@/db/schema/activity'
import type { Db } from '@/db/client'
import { findOrCreateLead, tagContact } from '@/db/queries/leads'
import { scheduleForEvent } from '@/features/automation/runner'
import { siteUrl } from '@/lib/auth/env'
import { archetypes, isMode, type ProtectiveMode } from './archetypes'
import { sendArchetypeStep } from './sequence-send'

/**
 * The event every archetype sequence hangs off.
 *
 * ONE event type for both ways in — the quiz and the opt-in form on an
 * archetype page — so there is one set of rules rather than two. A rule has a
 * single trigger, and duplicating twenty of them so that a woman who typed her
 * email gets the same words as a woman who answered twelve questions would be
 * a maintenance trap with an obvious failure mode: somebody edits one copy.
 *
 * `quiz.completed` still exists alongside it, for funnel analytics. They
 * answer different questions: this one is "she is in a sequence", that one is
 * "she finished the quiz".
 */
export const ARCHETYPE_ASSIGNED = 'archetype.assigned'

export interface JoinResult {
  /** False when she was already in this exact sequence. */
  joined: boolean
  firstEmailSent: boolean
}

export async function joinArchetypeSequence(input: {
  db: Db
  contactId: string
  mode: ProtectiveMode
  /** 'quiz' or 'opt-in', recorded so the two can be compared later. */
  source: string
  siteUrl: string
}): Promise<JoinResult> {
  const archetype = archetypes[input.mode]

  const [event] = await input.db
    .insert(activityEvents)
    .values({
      contactId: input.contactId,
      eventType: ARCHETYPE_ASSIGNED,
      entity: 'contacts',
      entityId: input.contactId,
      metadata: {
        archetype: input.mode,
        slug: archetype.slug,
        source: input.source,
      },
    })
    .returning()

  if (!event) return { joined: false, firstEmailSent: false }

  /*
   * Schedule steps 2-5 now rather than waiting for the hourly sweep.
   *
   * The sweep would catch it within the hour anyway, and is what makes this
   * self-healing if anything here fails. Doing it inline as well just means
   * her second email is timed from when she joined rather than from the top of
   * the next hour.
   */
  await scheduleForEvent(input.db, {
    id: event.id,
    type: ARCHETYPE_ASSIGNED,
    contactId: input.contactId,
    metadata: (event.metadata ?? {}) as Record<string, unknown>,
    occurredAt: event.occurredAt,
  })

  /*
   * Step 1 goes NOW, in this request, rather than through the queue.
   *
   * She has just been told her result is on its way. The only other clock in
   * this system is an hourly cron, so routing the welcome through it would
   * mean "check your inbox" is a promise that is false for up to an hour —
   * which is exactly when she is still looking.
   *
   * It is still idempotent on (archetype, step, contact), so a rule that also
   * covered step 1 could not double it up.
   */
  const outcome = await sendArchetypeStep({
    db: input.db,
    contactId: input.contactId,
    mode: input.mode,
    step: 1,
    siteUrl: input.siteUrl,
  })

  return { joined: true, firstEmailSent: outcome.sent }
}

export const optInInput = z.object({
  archetype: z.string().trim().min(1),
  firstName: z.string().trim().min(1, 'Tell me what to call you.').max(80),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('That address does not look right.'),
})

export type OptInInput = z.infer<typeof optInInput>

export type OptInOutcome =
  | { ok: true; archetype: ProtectiveMode }
  | { ok: false; error: string }

/**
 * Join a sequence WITHOUT taking the quiz.
 *
 * She arrived on an archetype page because a friend shared it, read three
 * lines and recognised herself. Making her answer twelve questions to confirm
 * something she already knows is friction for its own sake — and she is the
 * warmest lead on the site, because she self-identified.
 *
 * She is tagged `self-identified` alongside her archetype, so the two groups
 * can be told apart later. A woman who chose her own archetype and a woman the
 * quiz chose for her are not the same person, and pretending otherwise would
 * quietly poison every number built on the tag.
 */
export async function subscribeToArchetype(
  input: OptInInput,
): Promise<OptInOutcome> {
  // The form carries the slug, because that is what the URL she is standing on
  // says. The mode is derived here rather than trusted from the request.
  const archetype = Object.values(archetypes).find(
    (a) => a.slug === input.archetype || a.mode === input.archetype,
  )
  if (!archetype || !isMode(archetype.mode)) {
    return { ok: false, error: 'That is not one of the four.' }
  }

  const contactId = await findOrCreateLead(db, {
    email: input.email,
    firstName: input.firstName,
    source: `archetype-opt-in:${archetype.slug}`,
  })
  if (!contactId) return { ok: false, error: 'That did not save. Try again.' }

  await tagContact(db, contactId, {
    slug: `archetype-${archetype.slug}`,
    name: archetype.name,
  })
  await tagContact(db, contactId, {
    slug: 'archetype-self-identified',
    name: 'Self-identified archetype',
  })

  await joinArchetypeSequence({
    db,
    contactId,
    mode: archetype.mode,
    source: 'opt-in',
    siteUrl: siteUrl(),
  })

  return { ok: true, archetype: archetype.mode }
}

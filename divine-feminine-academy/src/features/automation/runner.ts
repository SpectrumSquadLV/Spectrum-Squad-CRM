import 'server-only'

import { and, asc, eq, lte, or, isNull, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
  automationRules,
  automationRuns,
  contactStageHistory,
  contactTags,
  contacts,
  crmStages,
  followUps,
  tags,
} from '@/db/schema'
import { isTooLate, matchRules, type Rule, type TriggerEvent } from './matching'

/**
 * Scheduling and running automations.
 *
 * Two halves, deliberately separate:
 *
 *   - `scheduleForEvent` decides WHAT should happen and writes a run row. It is
 *     safe to call repeatedly: a unique index on the idempotency key means the
 *     same rule, contact and event can only ever produce one run.
 *   - `runDue` decides WHEN, and executes. It claims each run before acting, so
 *     two overlapping cron invocations cannot both send the same email.
 */

function toRule(row: typeof automationRules.$inferSelect): Rule {
  return {
    id: row.id,
    name: row.name,
    triggerEvent: row.triggerEvent,
    conditions: (row.conditions ?? {}) as Rule['conditions'],
    delayMinutes: row.delayMinutes,
    action: row.action,
    actionConfig: (row.actionConfig ?? {}) as Record<string, unknown>,
    isActive: row.isActive,
  }
}

export async function scheduleForEvent(
  db: Db,
  event: TriggerEvent,
): Promise<number> {
  const rows = await db
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.triggerEvent, event.type),
        eq(automationRules.isActive, true),
      ),
    )

  const scheduled = matchRules(rows.map(toRule), event)
  if (scheduled.length === 0) return 0

  let created = 0
  for (const run of scheduled) {
    const inserted = await db
      .insert(automationRuns)
      .values({
        ruleId: run.ruleId,
        contactId: run.contactId,
        idempotencyKey: run.idempotencyKey,
        status: 'scheduled',
        scheduledFor: run.scheduledFor,
      })
      .onConflictDoNothing({ target: automationRuns.idempotencyKey })
      .returning({ id: automationRuns.id })

    if (inserted.length > 0) created++
  }

  return created
}

export interface ActionContext {
  db: Db
  contactId: string
  rule: Rule
  runId: string
}

export type ActionHandler = (ctx: ActionContext) => Promise<void>

/**
 * How each action is carried out.
 *
 * `send_email` is injected rather than imported so the runner can be tested
 * without sending anything.
 */
export interface Handlers {
  send_email: ActionHandler
  send_sms?: ActionHandler
}

async function addTag(ctx: ActionContext) {
  const name = String(ctx.rule.actionConfig.tag ?? '').trim()
  if (!name) return
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) return

  const [tag] = await ctx.db
    .insert(tags)
    .values({ name, slug })
    .onConflictDoUpdate({ target: tags.slug, set: { name } })
    .returning()
  if (!tag) return

  await ctx.db
    .insert(contactTags)
    .values({ contactId: ctx.contactId, tagId: tag.id })
    .onConflictDoNothing({ target: [contactTags.contactId, contactTags.tagId] })
}

async function removeTag(ctx: ActionContext) {
  const slug = String(ctx.rule.actionConfig.tag ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
  if (!slug) return

  const [tag] = await ctx.db.select().from(tags).where(eq(tags.slug, slug)).limit(1)
  if (!tag) return

  await ctx.db
    .delete(contactTags)
    .where(
      sql`${contactTags.contactId} = ${ctx.contactId} AND ${contactTags.tagId} = ${tag.id}`,
    )
}

async function changeStage(ctx: ActionContext) {
  const slug = String(ctx.rule.actionConfig.stageSlug ?? '')
  if (!slug) return

  const [stage] = await ctx.db
    .select()
    .from(crmStages)
    .where(eq(crmStages.slug, slug))
    .limit(1)
  if (!stage) return

  const [contact] = await ctx.db
    .select({ crmStageId: contacts.crmStageId })
    .from(contacts)
    .where(eq(contacts.id, ctx.contactId))
    .limit(1)
  if (!contact || contact.crmStageId === stage.id) return

  await ctx.db
    .update(contacts)
    .set({ crmStageId: stage.id, updatedAt: new Date() })
    .where(eq(contacts.id, ctx.contactId))

  await ctx.db.insert(contactStageHistory).values({
    contactId: ctx.contactId,
    fromStageId: contact.crmStageId,
    toStageId: stage.id,
  })
}

async function createFollowUp(ctx: ActionContext) {
  const inDays = Number(ctx.rule.actionConfig.inDays ?? 3)
  await ctx.db.insert(followUps).values({
    contactId: ctx.contactId,
    dueAt: new Date(Date.now() + Math.max(0, inDays) * 86_400_000),
    note: String(ctx.rule.actionConfig.note ?? ctx.rule.name),
  })
}

export interface RunSummary {
  claimed: number
  succeeded: number
  failed: number
  skipped: number
}

export async function runDue(
  db: Db,
  handlers: Handlers,
  now = new Date(),
  limit = 100,
): Promise<RunSummary> {
  const due = await db
    .select({ run: automationRuns, rule: automationRules })
    .from(automationRuns)
    .innerJoin(automationRules, eq(automationRules.id, automationRuns.ruleId))
    .where(
      and(
        eq(automationRuns.status, 'scheduled'),
        or(
          isNull(automationRuns.scheduledFor),
          lte(automationRuns.scheduledFor, now),
        ),
      ),
    )
    .orderBy(asc(automationRuns.scheduledFor))
    .limit(limit)

  const summary: RunSummary = { claimed: 0, succeeded: 0, failed: 0, skipped: 0 }

  for (const { run, rule } of due) {
    /*
     * Claim it first.
     *
     * The WHERE still requires status = 'scheduled', so if another cron
     * invocation got here a millisecond earlier this update matches nothing
     * and we move on. Without this, two overlapping runs both send.
     */
    const claimed = await db
      .update(automationRuns)
      .set({ status: 'succeeded', executedAt: now, updatedAt: now })
      .where(
        and(
          eq(automationRuns.id, run.id),
          eq(automationRuns.status, 'scheduled'),
        ),
      )
      .returning({ id: automationRuns.id })

    if (claimed.length === 0) continue
    summary.claimed++

    // Too stale to be useful: "Day 2 is open" arriving on Day 6 is worse
    // than silence.
    if (isTooLate(run.scheduledFor, now)) {
      await db
        .update(automationRuns)
        .set({ status: 'skipped', error: 'too late to be useful', updatedAt: now })
        .where(eq(automationRuns.id, run.id))
      summary.skipped++
      continue
    }

    const ctx: ActionContext = {
      db,
      contactId: run.contactId,
      rule: toRule(rule),
      runId: run.id,
    }

    try {
      switch (ctx.rule.action) {
        case 'send_email':
          await handlers.send_email(ctx)
          break
        case 'send_sms':
          if (handlers.send_sms) await handlers.send_sms(ctx)
          break
        case 'add_tag':
          await addTag(ctx)
          break
        case 'remove_tag':
          await removeTag(ctx)
          break
        case 'change_stage':
          await changeStage(ctx)
          break
        case 'create_follow_up':
          await createFollowUp(ctx)
          break
        case 'enroll_in_program':
          // Enrolment is granted by payment, never by an automation. Leaving
          // this unimplemented is deliberate: an automation that can hand out
          // paid programmes is a hole waiting to be found.
          break
      }
      summary.succeeded++
    } catch (error) {
      await db
        .update(automationRuns)
        .set({
          status: 'failed',
          error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
          updatedAt: now,
        })
        .where(eq(automationRuns.id, run.id))
      summary.failed++
    }
  }

  return summary
}

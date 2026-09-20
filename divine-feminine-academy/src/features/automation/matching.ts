/**
 * Which automation rules fire for an event, and when.
 *
 * Pure functions with no database and no clock of their own. The consequences
 * of getting this wrong are a woman emailed five times in an hour, or not at
 * all on the day the challenge depends on, so the rules are worth testing
 * directly.
 */

export type AutomationAction =
  | 'send_email'
  | 'send_sms'
  | 'add_tag'
  | 'remove_tag'
  | 'change_stage'
  | 'enroll_in_program'
  | 'create_follow_up'

export interface Rule {
  id: string
  name: string
  triggerEvent: string
  /** Extra predicates over the event's metadata. */
  conditions: Conditions
  delayMinutes: number
  action: AutomationAction
  actionConfig: Record<string, unknown>
  isActive: boolean
}

/**
 * Conditions are deliberately small.
 *
 * `equals`, `notEquals`, `gte`, `lte`, `in` and `exists` over the event's
 * metadata. Anything richer wants a real rule language, and a real rule
 * language is a product of its own.
 */
export interface Conditions {
  equals?: Record<string, unknown>
  notEquals?: Record<string, unknown>
  gte?: Record<string, number>
  lte?: Record<string, number>
  in?: Record<string, unknown[]>
  exists?: string[]
}

export interface TriggerEvent {
  id: string
  type: string
  contactId: string | null
  metadata: Record<string, unknown>
  occurredAt: Date
}

const sameValue = (a: unknown, b: unknown) =>
  a === b || (a === null && b === undefined) || (a === undefined && b === null)

export function conditionsMatch(
  conditions: Conditions,
  metadata: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(conditions.equals ?? {})) {
    if (!sameValue(metadata[key], expected)) return false
  }
  for (const [key, expected] of Object.entries(conditions.notEquals ?? {})) {
    if (sameValue(metadata[key], expected)) return false
  }
  for (const [key, min] of Object.entries(conditions.gte ?? {})) {
    const value = Number(metadata[key])
    if (!Number.isFinite(value) || value < min) return false
  }
  for (const [key, max] of Object.entries(conditions.lte ?? {})) {
    const value = Number(metadata[key])
    if (!Number.isFinite(value) || value > max) return false
  }
  for (const [key, allowed] of Object.entries(conditions.in ?? {})) {
    if (!allowed.some((candidate) => sameValue(metadata[key], candidate))) {
      return false
    }
  }
  for (const key of conditions.exists ?? []) {
    if (metadata[key] === undefined || metadata[key] === null) return false
  }
  return true
}

export interface ScheduledRun {
  ruleId: string
  contactId: string
  idempotencyKey: string
  scheduledFor: Date
}

/**
 * The idempotency key.
 *
 * (rule, contact, event) — so the same rule reacting to the same event for the
 * same woman can only ever produce one run, however many times the event is
 * replayed or the matcher re-runs.
 */
export function idempotencyKeyFor(
  ruleId: string,
  contactId: string,
  eventId: string,
): string {
  return `${ruleId}:${contactId}:${eventId}`
}

export function matchRules(
  rules: Rule[],
  event: TriggerEvent,
): ScheduledRun[] {
  // An automation acts ON somebody. An event with no contact has nobody to act
  // on, so nothing fires.
  if (!event.contactId) return []

  const contactId = event.contactId

  return rules
    .filter((rule) => rule.isActive)
    .filter((rule) => rule.triggerEvent === event.type)
    .filter((rule) => conditionsMatch(rule.conditions, event.metadata))
    .map((rule) => ({
      ruleId: rule.id,
      contactId,
      idempotencyKey: idempotencyKeyFor(rule.id, contactId, event.id),
      scheduledFor: new Date(
        event.occurredAt.getTime() + Math.max(0, rule.delayMinutes) * 60_000,
      ),
    }))
}

/** Runs whose time has come. */
export function isDue(scheduledFor: Date | null, now: Date): boolean {
  if (!scheduledFor) return true
  return scheduledFor.getTime() <= now.getTime()
}

/**
 * How stale is too stale.
 *
 * A run that should have gone out four days ago is not worth sending: "Day 2
 * is open" arriving on Day 6 is worse than silence. Anything older than the
 * cutoff is skipped rather than fired late.
 */
export function isTooLate(
  scheduledFor: Date | null,
  now: Date,
  maxAgeHours = 36,
): boolean {
  if (!scheduledFor) return false
  return now.getTime() - scheduledFor.getTime() > maxAgeHours * 3_600_000
}

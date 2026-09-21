/**
 * Automation matching, scheduling and execution.
 *
 * The failure modes are both bad: a woman emailed five times in an hour, or
 * not at all on the day the challenge depends on. The matcher is pure, so it
 * is tested directly; the runner is tested against a real database with a fake
 * email handler.
 *
 * Run: DATABASE_URL=... npm run verify:automation
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

process.env.JOURNAL_MASTER_KEY ??= randomBytes(32).toString('base64')

const {
  conditionsMatch,
  idempotencyKeyFor,
  isDue,
  isTooLate,
  matchRules,
} = await import('../src/features/automation/matching')
type Rule = import('../src/features/automation/matching').Rule
type TriggerEvent = import('../src/features/automation/matching').TriggerEvent

const { db } = await import('../src/db/client')
const { contacts } = await import('../src/db/schema/identity')
const { automationRules, automationRuns } = await import('../src/db/schema/activity')
const { runDue, scheduleForEvent } = await import('../src/features/automation/runner')

function must<T>(v: T | null | undefined, m: string): T {
  if (!v) throw new Error(m)
  return v
}

let passed = 0
async function check(name: string, fn: () => void | Promise<void>) {
  await fn()
  passed++
  console.log(`  ok   ${name}`)
}

const NOW = new Date('2026-06-15T12:00:00Z')

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'rule-1',
  name: 'Test rule',
  triggerEvent: 'challenge.started',
  conditions: {},
  delayMinutes: 0,
  action: 'send_email',
  actionConfig: {},
  isActive: true,
  ...over,
})

const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  id: 'evt-1',
  type: 'challenge.started',
  contactId: 'contact-1',
  metadata: {},
  occurredAt: NOW,
  ...over,
})

console.log('conditions:')

await check('no conditions matches anything', () => {
  assert.equal(conditionsMatch({}, { anything: 1 }), true)
})

await check('equals must match', () => {
  assert.equal(conditionsMatch({ equals: { slug: 'a' } }, { slug: 'a' }), true)
  assert.equal(conditionsMatch({ equals: { slug: 'a' } }, { slug: 'b' }), false)
  assert.equal(conditionsMatch({ equals: { slug: 'a' } }, {}), false)
})

await check('notEquals excludes', () => {
  assert.equal(conditionsMatch({ notEquals: { slug: 'a' } }, { slug: 'b' }), true)
  assert.equal(conditionsMatch({ notEquals: { slug: 'a' } }, { slug: 'a' }), false)
})

await check('gte and lte compare numbers', () => {
  assert.equal(conditionsMatch({ gte: { day: 3 } }, { day: 3 }), true)
  assert.equal(conditionsMatch({ gte: { day: 3 } }, { day: 2 }), false)
  assert.equal(conditionsMatch({ lte: { day: 3 } }, { day: 3 }), true)
  assert.equal(conditionsMatch({ lte: { day: 3 } }, { day: 4 }), false)
})

await check('a missing number fails a comparison rather than passing it', () => {
  assert.equal(conditionsMatch({ gte: { day: 1 } }, {}), false)
  assert.equal(conditionsMatch({ lte: { day: 99 } }, { day: 'nonsense' }), false)
})

await check('in matches any of a set', () => {
  assert.equal(conditionsMatch({ in: { area: ['herself', 'relationships'] } }, { area: 'relationships' }), true)
  assert.equal(conditionsMatch({ in: { area: ['herself', 'relationships'] } }, { area: 'success' }), false)
})

await check('exists requires a value that is not null', () => {
  assert.equal(conditionsMatch({ exists: ['orderId'] }, { orderId: 'x' }), true)
  assert.equal(conditionsMatch({ exists: ['orderId'] }, { orderId: null }), false)
  assert.equal(conditionsMatch({ exists: ['orderId'] }, {}), false)
})

console.log('\nmatching rules to an event:')

await check('a matching active rule fires', () => {
  assert.equal(matchRules([rule()], event()).length, 1)
})

await check('an INACTIVE rule never fires', () => {
  assert.equal(matchRules([rule({ isActive: false })], event()).length, 0)
})

await check('a rule for a different event never fires', () => {
  assert.equal(matchRules([rule({ triggerEvent: 'other' })], event()).length, 0)
})

await check('an event with NO CONTACT fires nothing', () => {
  assert.equal(matchRules([rule()], event({ contactId: null })).length, 0)
})

await check('a rule whose conditions do not match is skipped', () => {
  const r = rule({ conditions: { equals: { programSlug: 'me-vs-her' } } })
  assert.equal(matchRules([r], event({ metadata: { programSlug: 'other' } })).length, 0)
  assert.equal(
    matchRules([r], event({ metadata: { programSlug: 'me-vs-her' } })).length,
    1,
  )
})

await check('the delay is applied from when the event happened', () => {
  const [run] = matchRules([rule({ delayMinutes: 90 })], event())
  assert.equal(run!.scheduledFor.toISOString(), '2026-06-15T13:30:00.000Z')
})

await check('a negative delay is treated as none, not as the past', () => {
  const [run] = matchRules([rule({ delayMinutes: -500 })], event())
  assert.equal(run!.scheduledFor.getTime(), NOW.getTime())
})

await check('several rules on one event all fire', () => {
  const runs = matchRules([rule(), rule({ id: 'rule-2' })], event())
  assert.equal(runs.length, 2)
  assert.notEqual(runs[0]!.idempotencyKey, runs[1]!.idempotencyKey)
})

console.log('\nidempotency keys:')

await check('the key is stable for the same rule, contact and event', () => {
  assert.equal(idempotencyKeyFor('r', 'c', 'e'), idempotencyKeyFor('r', 'c', 'e'))
})

await check('and differs when any of the three differ', () => {
  const base = idempotencyKeyFor('r', 'c', 'e')
  assert.notEqual(base, idempotencyKeyFor('r2', 'c', 'e'))
  assert.notEqual(base, idempotencyKeyFor('r', 'c2', 'e'))
  assert.notEqual(base, idempotencyKeyFor('r', 'c', 'e2'))
})

console.log('\ndue and too late:')

await check('a run with no schedule is due immediately', () => {
  assert.equal(isDue(null, NOW), true)
})

await check('a future run is not due', () => {
  assert.equal(isDue(new Date(NOW.getTime() + 60_000), NOW), false)
  assert.equal(isDue(new Date(NOW.getTime() - 60_000), NOW), true)
})

await check('a run four days stale is too late to send', () => {
  assert.equal(isTooLate(new Date(NOW.getTime() - 4 * 86_400_000), NOW), true)
  assert.equal(isTooLate(new Date(NOW.getTime() - 3_600_000), NOW), false)
})

console.log('\nscheduling and running, against the database:')

const contact = must(
  (
    await db
      .insert(contacts)
      .values({ email: `auto-${randomUUID()}@example.test`, firstName: 'Auto' })
      .returning()
  )[0],
  'no contact',
)

const dbRule = must(
  (
    await db
      .insert(automationRules)
      .values({
        name: 'Welcome',
        triggerEvent: 'test.started',
        conditions: {},
        delayMinutes: 0,
        action: 'send_email',
        actionConfig: { template: 'nudge' },
        isActive: true,
      })
      .returning()
  )[0],
  'no rule',
)

const eventId = randomUUID()
const dbEvent: TriggerEvent = {
  id: eventId,
  type: 'test.started',
  contactId: contact.id,
  metadata: {},
  occurredAt: new Date(),
}

await check('scheduling creates exactly one run', async () => {
  const created = await scheduleForEvent(db, dbEvent)
  assert.equal(created, 1)
})

await check('scheduling the SAME event again creates none', async () => {
  const created = await scheduleForEvent(db, dbEvent)
  assert.equal(created, 0, 'a replayed event scheduled a second run')

  const rows = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.contactId, contact.id))
  assert.equal(rows.length, 1)
})

let sends = 0

await check('running executes it once', async () => {
  const summary = await runDue(db, {
    send_email: async () => {
      sends++
    },
  })
  assert.ok(summary.claimed >= 1)
  assert.equal(sends, 1)
})

await check('running AGAIN does not execute it a second time', async () => {
  await runDue(db, {
    send_email: async () => {
      sends++
    },
  })
  assert.equal(sends, 1, 'the same run was executed twice')
})

await check('a failing action is recorded as failed, not silently swallowed', async () => {
  const failEvent: TriggerEvent = { ...dbEvent, id: randomUUID() }
  await scheduleForEvent(db, failEvent)

  const summary = await runDue(db, {
    send_email: async () => {
      throw new Error('provider exploded')
    },
  })
  assert.equal(summary.failed, 1)

  const rows = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.contactId, contact.id))
  const failedRun = rows.find((r) => r.status === 'failed')
  assert.ok(failedRun, 'no run was marked failed')
  assert.match(failedRun.error ?? '', /exploded/)
})

await check('a stale run is skipped rather than sent late', async () => {
  const staleEvent: TriggerEvent = { ...dbEvent, id: randomUUID() }
  await scheduleForEvent(db, staleEvent)

  // Backdate it well past the cutoff.
  await db
    .update(automationRuns)
    .set({ scheduledFor: new Date(Date.now() - 5 * 86_400_000) })
    .where(eq(automationRuns.idempotencyKey, `${dbRule.id}:${contact.id}:${staleEvent.id}`))

  const before = sends
  const summary = await runDue(db, {
    send_email: async () => {
      sends++
    },
  })
  assert.equal(summary.skipped, 1, 'a four-day-old reminder was sent anyway')
  assert.equal(sends, before, 'a stale run still sent an email')
})

// -------------------------------------------------------------- teardown ---
await db.delete(automationRuns).where(eq(automationRuns.contactId, contact.id))
await db.delete(contacts).where(eq(contacts.id, contact.id))
await db.delete(automationRules).where(eq(automationRules.id, dbRule.id))

console.log(`\nautomation: all ${passed} checks passed`)
process.exit(0)

/**
 * Day reminders and email suppression.
 *
 * The reminder is the one email the challenge depends on, and the two ways it
 * fails are both silent: arriving at 3am her time, or arriving three times.
 *
 * Run: DATABASE_URL=... npm run verify:reminders
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

process.env.JOURNAL_MASTER_KEY ??= randomBytes(32).toString('base64')
process.env.EMAIL_PROVIDER = 'fake'

const { localDateKey, localHour, sendDayReminders } = await import(
  '../src/features/automation/jobs'
)
const { db } = await import('../src/db/client')
const { contacts, profiles } = await import('../src/db/schema/identity')
const { emailEvents } = await import('../src/db/schema/activity')
const { enrollments } = await import('../src/db/schema/progress')
const { programs, programVersions } = await import('../src/db/schema/programs')
const { dayReminder, nudge, orderReceipt } = await import(
  '../src/features/email/templates'
)
const { sendToContact, isSuppressed } = await import('../src/features/email/send')

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

const LA = 'America/Los_Angeles'
const TOKYO = 'Asia/Tokyo'
const SITE = 'https://example.test'

console.log('her clock, not the server\'s:')

await check('the local hour is read in her timezone', () => {
  // 2026-06-15T15:00Z is 8am in Los Angeles and midnight in Tokyo.
  const at = new Date('2026-06-15T15:00:00Z')
  assert.equal(localHour(at, LA), 8)
  assert.equal(localHour(at, TOKYO), 0)
})

await check('the local date is hers too', () => {
  const at = new Date('2026-06-15T15:00:00Z')
  assert.equal(localDateKey(at, LA), '2026-06-15')
  assert.equal(localDateKey(at, TOKYO), '2026-06-16')
})

await check('a nonsense timezone falls back instead of throwing', () => {
  assert.ok(Number.isInteger(localHour(new Date(), 'Not/AZone')))
})

console.log('\ntemplates:')

await check('a reminder carries the day, the title and a working link', () => {
  const email = dayReminder({
    firstName: 'Maya',
    dayNumber: 3,
    dayTitle: 'Whose approval',
    totalDays: 7,
    programSlug: 'me-vs-her',
    siteUrl: SITE,
  })
  assert.match(email.subject, /Day 3 of 7/)
  assert.match(email.html, /Whose approval/)
  assert.match(email.html, /my-academy\/me-vs-her\/day\/3/)
  assert.match(email.text, /my-academy\/me-vs-her\/day\/3/)
})

await check('every template has a text part, not just HTML', () => {
  for (const email of [
    dayReminder({
      firstName: null, dayNumber: 1, dayTitle: 'Meet her', totalDays: 7,
      programSlug: 'p', siteUrl: SITE,
    }),
    nudge({ firstName: null, dayNumber: 2, programSlug: 'p', daysSince: 3, siteUrl: SITE }),
    orderReceipt({
      firstName: null, programTitle: 'The Divine Feminine', amountLabel: '$1,000.00',
      orderReference: 'abc123', refundWindowDays: 14, siteUrl: SITE,
    }),
  ]) {
    assert.ok(email.text.length > 40, 'a template had no usable text part')
    assert.ok(email.subject.length > 0)
  }
})

await check('a name with HTML in it is escaped, not rendered', () => {
  const email = dayReminder({
    firstName: '<script>alert(1)</script>',
    dayNumber: 1, dayTitle: 'x', totalDays: 7, programSlug: 'p', siteUrl: SITE,
  })
  assert.ok(!email.html.includes('<script>'), 'a name was injected into the HTML')
  assert.match(email.html, /&lt;script&gt;/)
})

await check('a woman with no name is addressed, not left blank', () => {
  const email = dayReminder({
    firstName: null, dayNumber: 1, dayTitle: 'Meet her', totalDays: 7,
    programSlug: 'p', siteUrl: SITE,
  })
  assert.ok(!email.html.includes('null'), 'a null name leaked into the email')
  assert.match(email.text, /there/)
})

console.log('\nsending, against the database:')

const contact = must(
  (
    await db
      .insert(contacts)
      .values({ email: `rem-${randomUUID()}@example.test`, firstName: 'Maya', timezone: LA })
      .returning()
  )[0],
  'no contact',
)

const rendered = nudge({
  firstName: 'Maya', dayNumber: 2, programSlug: 'p', daysSince: 3, siteUrl: SITE,
})

await check('a lifecycle email sends and is recorded', async () => {
  const outcome = await sendToContact({
    db, contactId: contact.id, rendered, kind: 'lifecycle',
    idempotencyKey: `test:${contact.id}:1`,
  })
  assert.equal(outcome.sent, true)

  const rows = await db.select().from(emailEvents).where(eq(emailEvents.contactId, contact.id))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.type, 'sent')
})

await check('the SAME idempotency key does not send twice', async () => {
  const outcome = await sendToContact({
    db, contactId: contact.id, rendered, kind: 'lifecycle',
    idempotencyKey: `test:${contact.id}:1`,
  })
  assert.equal(outcome.sent, false)
  assert.equal(outcome.reason, 'duplicate')
})

await check('a woman who turned reminders OFF gets none', async () => {
  await db.insert(profiles).values({
    userId: randomUUID(),
    contactId: contact.id,
    notificationPrefs: { dailyEmail: false, reminderHour: 8 },
  })

  const outcome = await sendToContact({
    db, contactId: contact.id, rendered, kind: 'lifecycle',
    idempotencyKey: `test:${contact.id}:2`,
  })
  assert.equal(outcome.sent, false)
  assert.equal(outcome.reason, 'opted-out')
})

await check('but she still gets TRANSACTIONAL email', async () => {
  const outcome = await sendToContact({
    db, contactId: contact.id, rendered, kind: 'transactional',
    idempotencyKey: `test:${contact.id}:3`,
  })
  assert.equal(
    outcome.sent,
    true,
    'turning off reminders must not block her sign-in links',
  )
})

await check('a BOUNCED address is never written to again', async () => {
  await db.insert(emailEvents).values({ contactId: contact.id, type: 'bounced' })
  assert.equal(await isSuppressed(db, contact.id), true)

  const outcome = await sendToContact({
    db, contactId: contact.id, rendered, kind: 'transactional',
    idempotencyKey: `test:${contact.id}:4`,
  })
  assert.equal(outcome.sent, false)
  assert.equal(outcome.reason, 'suppressed')
})

console.log('\nthe reminder job:')

const program = must(
  (await db.select().from(programs).where(eq(programs.slug, 'me-vs-her')).limit(1))[0],
  'run `npm run seed:challenge` first',
)
const version = must(
  (
    await db
      .select()
      .from(programVersions)
      .where(eq(programVersions.programId, program.id))
      .orderBy(programVersions.version)
      .limit(1)
  )[0],
  'no version',
)

const learner = must(
  (
    await db
      .insert(contacts)
      .values({ email: `job-${randomUUID()}@example.test`, firstName: 'Renee', timezone: LA })
      .returning()
  )[0],
  'no learner',
)
await db.insert(profiles).values({
  userId: randomUUID(),
  contactId: learner.id,
  notificationPrefs: { dailyEmail: true, reminderHour: 8 },
})
// Started the previous morning her time, so Day 1 is unlocked by the test
// clock below. `startedAt` defaults to now(), which would be AFTER the fixed
// times used here and would leave nothing unlocked.
await db.insert(enrollments).values({
  contactId: learner.id,
  programId: program.id,
  versionId: version.id,
  timezoneAtStart: LA,
  startedAt: new Date('2026-06-14T16:00:00Z'),
})

// 8am in Los Angeles, the day after she started.
const herMorning = new Date('2026-06-15T15:00:00Z')

await check('nothing is sent at the wrong hour', async () => {
  const noon = new Date('2026-06-15T19:00:00Z') // 12pm LA
  const summary = await sendDayReminders(db, SITE, noon)
  const rows = await db.select().from(emailEvents).where(eq(emailEvents.contactId, learner.id))
  assert.equal(rows.length, 0, `something sent at the wrong hour (${summary.sent})`)
})

await check('a reminder IS sent at her hour', async () => {
  const summary = await sendDayReminders(db, SITE, herMorning)
  assert.ok(summary.sent >= 1, 'no reminder was sent at her chosen hour')
})

await check('running the job again the same day sends nothing more', async () => {
  const before = (
    await db.select().from(emailEvents).where(eq(emailEvents.contactId, learner.id))
  ).length
  await sendDayReminders(db, SITE, herMorning)
  await sendDayReminders(db, SITE, new Date(herMorning.getTime() + 60_000))
  const after = (
    await db.select().from(emailEvents).where(eq(emailEvents.contactId, learner.id))
  ).length
  assert.equal(after, before, 'she was reminded more than once in a day')
})

// -------------------------------------------------------------- teardown ---
for (const id of [contact.id, learner.id]) {
  await db.delete(contacts).where(eq(contacts.id, id))
}

console.log(`\nreminders: all ${passed} checks passed`)
process.exit(0)

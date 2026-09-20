/**
 * Certificate issuance against a real database.
 *
 * The scoring rules are covered by verify-certificates; this proves the wiring:
 * that gathering her progress reads the right rows, that finishing everything
 * issues exactly one certificate, that not finishing issues none, and that
 * re-running cannot issue a second.
 *
 * Run: DATABASE_URL=... npm run verify:issuance
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'

process.env.JOURNAL_MASTER_KEY ??= randomBytes(32).toString('base64')

const { db } = await import('../src/db/client')
const { contacts } = await import('../src/db/schema/identity')
const { lessons, modules, programVersions, programs, lessonBlocks } = await import(
  '../src/db/schema/programs'
)
const { enrollments, lessonProgress, herCodes, blockResponses } = await import(
  '../src/db/schema/progress'
)
const { certificates } = await import('../src/db/schema/certificates')
const { gatherProgress, issueIfEarned, loadRequirements } = await import(
  '../src/features/certificates/issue'
)

/** Narrows away both undefined (from `[0]`) and null (from a lookup miss). */
function must<T>(value: T | null | undefined, message: string): T {
  if (!value) throw new Error(message)
  return value
}

let passed = 0
async function check(name: string, fn: () => void | Promise<void>) {
  await fn()
  passed++
  console.log(`  ok   ${name}`)
}

const program = must(
  (
    await db.select().from(programs).where(eq(programs.slug, '7-days-to-her')).limit(1)
  )[0],
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

async function makeWoman(name: string) {
  const contact = must(
    (
      await db
        .insert(contacts)
        .values({ email: `cert-${randomUUID()}@example.test`, firstName: name })
        .returning()
    )[0],
    'could not create a contact',
  )
  const enrollment = must(
    (
      await db
        .insert(enrollments)
        .values({
          contactId: contact.id,
          programId: program.id,
          versionId: version.id,
          timezoneAtStart: 'America/Los_Angeles',
        })
        .returning()
    )[0],
    'could not enrol',
  )
  return { contact, enrollment }
}

const created: string[] = []

console.log('requirements:')

await check('the seeded programme actually has requirements', async () => {
  const requirements = await loadRequirements(db, program.id)
  assert.ok(requirements.length >= 1, 'no requirements configured')
})

console.log('\na woman who has done nothing:')

const idle = await makeWoman('Idle')
created.push(idle.contact.id)

await check('her progress reads as nothing done', async () => {
  const progress = must(await gatherProgress(db, idle.enrollment.id), 'no progress')
  assert.equal(progress.lessonsCompleted, 0)
  assert.equal(progress.herCodeFinalized, false)
  assert.ok(progress.lessonsTotal > 0, 'the programme should have lessons')
})

await check('she is issued NO certificate', async () => {
  const result = await issueIfEarned(db, idle.enrollment.id)
  assert.equal(result.issued, false)
  const rows = await db
    .select()
    .from(certificates)
    .where(eq(certificates.contactId, idle.contact.id))
  assert.equal(rows.length, 0)
})

console.log('\na woman who has done everything:')

const finisher = await makeWoman('Finisher')
created.push(finisher.contact.id)

// Finish every lesson, answer every required block, write the HER Code.
const allLessons = await db
  .select({ id: lessons.id })
  .from(lessons)
  .innerJoin(modules, eq(modules.id, lessons.moduleId))
  .where(eq(modules.versionId, version.id))

for (const lesson of allLessons) {
  await db.insert(lessonProgress).values({
    enrollmentId: finisher.enrollment.id,
    lessonId: lesson.id,
    status: 'completed',
    completedAt: new Date(),
  })
}

const requiredBlocks = await db
  .select({ id: lessonBlocks.id })
  .from(lessonBlocks)
  .innerJoin(lessons, eq(lessons.id, lessonBlocks.lessonId))
  .innerJoin(modules, eq(modules.id, lessons.moduleId))
  .where(and(eq(modules.versionId, version.id), eq(lessonBlocks.isRequired, true)))

for (const block of requiredBlocks) {
  await db.insert(blockResponses).values({
    enrollmentId: finisher.enrollment.id,
    blockId: block.id,
    response: { done: true },
    isSensitive: false,
  })
}

await db.insert(herCodes).values({
  contactId: finisher.contact.id,
  programId: program.id,
  sections: { lines: ['I am the woman who stays'], declaration: 'I choose her.' },
  shareToken: randomBytes(9).toString('base64url'),
})

await check('her progress reads as complete', async () => {
  const progress = must(await gatherProgress(db, finisher.enrollment.id), 'no progress')
  assert.equal(progress.lessonsCompleted, progress.lessonsTotal)
  assert.equal(progress.requiredBlocksAnswered, progress.requiredBlocksTotal)
  assert.equal(progress.herCodeFinalized, true)
})

let issuedNumber = ''

await check('she IS issued a certificate', async () => {
  const result = await issueIfEarned(db, finisher.enrollment.id)
  assert.equal(result.issued, true)
  assert.ok('certificate' in result && result.certificate)
  if ('certificate' in result && result.certificate) {
    issuedNumber = result.certificate.certificateNumber
    assert.match(issuedNumber, /^DFA-\d{4}-\d{6}$/)
    assert.ok(result.certificate.verificationToken.length > 20)
    assert.equal(result.certificate.recipientName, 'Finisher')
  }
})

await check('issuing again returns the SAME certificate, not a second', async () => {
  const again = await issueIfEarned(db, finisher.enrollment.id)
  assert.equal(again.issued, true)
  if ('certificate' in again && again.certificate) {
    assert.equal(again.certificate.certificateNumber, issuedNumber)
  }
  const rows = await db
    .select()
    .from(certificates)
    .where(eq(certificates.contactId, finisher.contact.id))
  assert.equal(rows.length, 1, 'a duplicate certificate was issued')
})

console.log('\na woman who did almost everything:')

const almost = await makeWoman('Almost')
created.push(almost.contact.id)

for (const lesson of allLessons.slice(0, allLessons.length - 1)) {
  await db.insert(lessonProgress).values({
    enrollmentId: almost.enrollment.id,
    lessonId: lesson.id,
    status: 'completed',
    completedAt: new Date(),
  })
}

await check('missing one day withholds the certificate', async () => {
  const result = await issueIfEarned(db, almost.enrollment.id)
  assert.equal(result.issued, false)
  if ('eligibility' in result && result.eligibility) {
    assert.ok(result.eligibility.outstanding.length > 0)
  }
  const rows = await db
    .select()
    .from(certificates)
    .where(eq(certificates.contactId, almost.contact.id))
  assert.equal(rows.length, 0)
})

// ------------------------------------------------------------- teardown ---
for (const id of created) {
  await db.delete(contacts).where(eq(contacts.id, id))
}

console.log(`\nissuance: all ${passed} checks passed`)
process.exit(0)

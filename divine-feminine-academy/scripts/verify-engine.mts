/**
 * The challenge engine, end to end, against a real database.
 *
 * The claims worth proving:
 *   - a sensitive block's answer is stored as CIPHERTEXT and nothing else
 *   - a non-sensitive block's answer is stored as readable JSON
 *   - Day 1 creates her HER profile, and re-saving edits it instead of
 *     duplicating it
 *   - Day 6 increments the metric the platform is built on
 *   - Day 5 writes a RETURN session
 *   - Day 7 writes a HER Code with a share token
 *   - the encrypted answers read back correctly for HER
 *
 * Run: DATABASE_URL=... npm run verify:engine
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'

process.env.JOURNAL_MASTER_KEY ??= randomBytes(32).toString('base64')

const { db } = await import('../src/db/client')
const { contacts } = await import('../src/db/schema/identity')
const { lessonBlocks, lessons, modules, programVersions, programs } = await import(
  '../src/db/schema/programs'
)
const {
  blockResponses,
  enrollments,
  herChoices,
  herCodes,
  herPatterns,
  journalEntries,
  returnSessions,
} = await import('../src/db/schema/progress')
const { getBlock } = await import('../src/blocks/registry')
const { runSideEffects, contactDataKey } = await import(
  '../src/features/challenge/side-effects'
)
const { encryptEntry, decryptEntry } = await import('../src/lib/crypto/journal')

/**
 * The guards below sit at module top level, but `save` and `blockOfType` are
 * hoisted declarations, so TypeScript will not carry a `if (!x) throw` guard
 * into them. Binding through this helper gives a genuinely non-optional const.
 */
function must<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message)
  return value
}

let passed = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => {
    passed++
    console.log(`  ok   ${name}`)
  })
}

// ---------------------------------------------------------------- setup ----
const email = `engine-${randomUUID()}@example.test`
const contact = must(
  (
    await db
      .insert(contacts)
      .values({ email, firstName: 'Test', timezone: 'America/Los_Angeles' })
      .returning()
  )[0],
  'could not create a contact',
)

const program = must(
  (
    await db
      .select()
      .from(programs)
      .where(eq(programs.slug, 'me-vs-her'))
      .limit(1)
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
  'no published version',
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

/**
 * A block of this type to save against.
 *
 * Prefers a seeded one, and makes a scratch one in the first seeded lesson
 * when the curriculum does not happen to contain that type.
 *
 * It used to throw instead, and that is how this whole file quietly stopped
 * running: the ME VS HER rewrite replaced Day 2's belief_origin with
 * protector_profile, and RETURN moved out of the curriculum into its own page,
 * so the script died on its first save against a curriculum that was perfectly
 * correct. What is under test here is the ENGINE - encryption, side effects,
 * idempotency - and none of that should care which blocks a given week of
 * content is made of.
 */
async function blockOfType(type: string) {
  const [seeded] = await db
    .select({ block: lessonBlocks, lesson: lessons, module: modules })
    .from(lessonBlocks)
    .innerJoin(lessons, eq(lessons.id, lessonBlocks.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(and(eq(modules.versionId, version.id), eq(lessonBlocks.type, type)))
    .limit(1)

  if (seeded) return seeded

  const [host] = await db
    .select({ lesson: lessons, module: modules })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.versionId, version.id))
    .limit(1)

  if (!host) throw new Error('the programme has no lessons at all — seed it first')

  const definition = getBlock(type)
  if (!definition) throw new Error(`no registry entry for ${type}`)

  /*
   * Position is unique per lesson, so it comes from the database rather than
   * from a counter. A counter resets every run while the blocks it made do
   * not, so the second run collides with the first one's leftovers.
   */
  const [last] = await db
    .select({ position: lessonBlocks.position })
    .from(lessonBlocks)
    .where(eq(lessonBlocks.lessonId, host.lesson.id))
    .orderBy(desc(lessonBlocks.position))
    .limit(1)

  const [made] = await db
    .insert(lessonBlocks)
    .values({
      lessonId: host.lesson.id,
      type,
      position: (last?.position ?? 0) + 1,
      config: scratchConfig[type] ?? {},
    })
    .returning()

  if (!made) throw new Error(`could not make a scratch ${type} block`)
  console.log(`  note  ${type} is not in this curriculum — made one to test against`)

  return { block: made, lesson: host.lesson, module: host.module }
}

/**
 * Minimum valid config for the types this script makes for itself.
 *
 * Only the fields the config schema requires. The member UI is not rendered
 * here; these blocks exist to be saved against.
 */
const scratchConfig: Record<string, Record<string, unknown>> = {
  belief_origin: { prompt: 'Where did it come from?' },
  return_practice: { prompt: 'What happened?' },
}

/**
 * Mirrors what the server action does, minus the session and drip checks
 * (those are exercised by the app; this proves the storage and side effects).
 */
async function save(type: string, response: Record<string, unknown>) {
  const located = await blockOfType(type)
  const definition = getBlock(type)
  if (!definition) throw new Error(`no registry entry for ${type}`)

  const isSensitive = definition.isSensitive
  await db
    .insert(blockResponses)
    .values({
      enrollmentId: enrollment.id,
      blockId: located.block.id,
      isSensitive,
      response: isSensitive ? null : response,
      responseEncrypted: isSensitive
        ? encryptEntry(JSON.stringify(response), await contactDataKey(db, contact.id))
        : null,
    })
    .onConflictDoUpdate({
      target: [blockResponses.enrollmentId, blockResponses.blockId],
      set: {
        response: isSensitive ? null : response,
        responseEncrypted: isSensitive
          ? encryptEntry(JSON.stringify(response), await contactDataKey(db, contact.id))
          : null,
        isSensitive,
        updatedAt: new Date(),
      },
    })

  await runSideEffects({
    db,
    contactId: contact.id,
    enrollmentId: enrollment.id,
    programId: program.id,
    lessonId: located.lesson.id,
    blockId: located.block.id,
    definition,
    response,
  })

  return located
}

async function storedFor(blockId: string) {
  const [row] = await db
    .select()
    .from(blockResponses)
    .where(
      and(
        eq(blockResponses.enrollmentId, enrollment.id),
        eq(blockResponses.blockId, blockId),
      ),
    )
    .limit(1)
  return row
}

console.log('storage:')

const SECRET = 'I was nine and I learned I was too much'

const day2 = await save('belief_origin', {
  belief: 'I am too much',
  origin: SECRET,
  cost: 'I make myself smaller',
  rewrite: 'I am exactly enough',
})

await check('a SENSITIVE answer is stored as ciphertext, not plain JSON', async () => {
  const row = await storedFor(day2.block.id)
  assert.ok(row, 'nothing was stored')
  assert.equal(row.isSensitive, true)
  assert.equal(row.response, null, 'plaintext column should be empty')
  assert.ok(row.responseEncrypted, 'ciphertext column should be set')
  assert.ok(
    !row.responseEncrypted.includes('nine'),
    'her words leaked into the stored value',
  )
  assert.ok(!row.responseEncrypted.includes('too much'))
})

await check('and it reads back correctly for HER', async () => {
  const row = await storedFor(day2.block.id)
  const key = await contactDataKey(db, contact.id)
  const decoded = JSON.parse(decryptEntry(row!.responseEncrypted!, key))
  assert.equal(decoded.origin, SECRET)
})

const day1 = await save('dual_column_exercise', {
  trigger: 'He goes quiet',
  currentResponse: 'I over-explain',
  herResponse: 'I let the silence sit',
})

await check('a NON-sensitive answer is stored as readable JSON', async () => {
  const row = await storedFor(day1.block.id)
  assert.equal(row!.isSensitive, false)
  assert.equal(row!.responseEncrypted, null)
  assert.deepEqual((row!.response as Record<string, unknown>).trigger, 'He goes quiet')
})

console.log('\nside effects:')

await check('Day 1 creates her HER profile', async () => {
  const rows = await db
    .select()
    .from(herPatterns)
    .where(eq(herPatterns.contactId, contact.id))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.triggerText, 'He goes quiet')
  assert.equal(rows[0]!.herResponse, 'I let the silence sit')
})

await check('re-saving Day 1 EDITS the pattern instead of duplicating it', async () => {
  await save('dual_column_exercise', {
    trigger: 'He goes quiet',
    currentResponse: 'I over-explain',
    herResponse: 'I ask once, then let it be',
  })
  const rows = await db
    .select()
    .from(herPatterns)
    .where(eq(herPatterns.contactId, contact.id))
  assert.equal(rows.length, 1, 'a second pattern was created')
  assert.equal(rows[0]!.herResponse, 'I ask once, then let it be')
})

await check('Day 2 also lands in her journal, encrypted', async () => {
  const rows = await db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.contactId, contact.id))
  assert.ok(rows.length >= 1, 'no journal entry was written')
  const entry = rows[0]!
  assert.ok(!entry.bodyEncrypted.includes('nine'), 'journal body was not encrypted')
  assert.ok(entry.wordCount > 0, 'word count should be stored in the clear')
  const key = await contactDataKey(db, contact.id)
  assert.ok(decryptEntry(entry.bodyEncrypted, key).includes(SECRET))
})

await check('Day 6 increments the core metric', async () => {
  await save('her_choice_capture', {
    situation: 'She asked me to cover her shift again',
    oldResponse: 'I would have said yes',
    herResponse: 'I said no',
    area: 'success',
  })
  const rows = await db
    .select()
    .from(herChoices)
    .where(eq(herChoices.contactId, contact.id))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.herResponse, 'I said no')
  assert.equal(rows[0]!.area, 'success')
})

await check('re-saving Day 6 does not double-count', async () => {
  await save('her_choice_capture', {
    situation: 'She asked me to cover her shift again',
    oldResponse: 'I would have said yes',
    herResponse: 'I said no, and did not explain',
    area: 'success',
  })
  const rows = await db
    .select()
    .from(herChoices)
    .where(eq(herChoices.contactId, contact.id))
  assert.equal(rows.length, 1, 'the metric was inflated by an edit')
  assert.equal(rows[0]!.herResponse, 'I said no, and did not explain')
})

await check('Day 5 writes a RETURN session', async () => {
  await save('return_practice', {
    whatHappened: 'A message I did not get back',
    feeling: 'small',
    meaningMade: 'that I am forgettable',
    isItTrue: 'no',
    whatINeed: 'air',
    actionChosen: 'nature',
  })
  const rows = await db
    .select()
    .from(returnSessions)
    .where(eq(returnSessions.contactId, contact.id))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.actionChosen, 'nature')
})

await check('Day 7 writes a HER Code with a share token', async () => {
  await save('her_code_builder', {
    lines: ['I am the woman who says the thing', '', 'I am the woman who stays'],
    declaration: 'I do not abandon myself to be chosen.',
  })
  const rows = await db
    .select()
    .from(herCodes)
    .where(eq(herCodes.contactId, contact.id))
  assert.equal(rows.length, 1)
  const sections = rows[0]!.sections as { lines: string[]; declaration: string }
  assert.equal(sections.lines.length, 2, 'blank lines should be dropped')
  assert.equal(sections.declaration, 'I do not abandon myself to be chosen.')
  assert.ok(rows[0]!.shareToken, 'no share token, so it cannot be shared')
})

console.log('\nregistry integrity:')

await check('every seeded block type exists in the registry', async () => {
  const rows = await db
    .select({ type: lessonBlocks.type })
    .from(lessonBlocks)
    .innerJoin(lessons, eq(lessons.id, lessonBlocks.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.versionId, version.id))

  for (const row of rows) {
    assert.ok(getBlock(row.type), `seeded block "${row.type}" is not registered`)
  }
})

await check('every registry definition survives being read on the server', async () => {
  const { listBlocks } = await import('../src/blocks/registry')
  for (const def of listBlocks()) {
    assert.equal(typeof def.type, 'string', 'a definition lost its type')
    assert.ok(def.type.length > 0)
    assert.equal(typeof def.isSensitive, 'boolean', `${def.type} lost isSensitive`)
    assert.ok(def.configSchema, `${def.type} lost its config schema`)
  }
})

// -------------------------------------------------------------- teardown ---
await db.delete(contacts).where(eq(contacts.id, contact.id))

console.log(`\nengine: all ${passed} checks passed`)
process.exit(0)

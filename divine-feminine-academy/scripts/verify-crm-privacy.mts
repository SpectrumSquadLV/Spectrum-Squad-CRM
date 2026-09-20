/**
 * The CRM cannot read her journal.
 *
 * Phase 5 put a full contact view in front of staff. The claim on the privacy
 * page is that they see engagement and never words, so this seeds a woman with
 * a real encrypted entry and checks that NOTHING the contact view returns
 * contains any of it.
 *
 * Run: DATABASE_URL=... npm run verify:crm-privacy
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

process.env.JOURNAL_MASTER_KEY ??= randomBytes(32).toString('base64')

const { db } = await import('../src/db/client')
const { contacts } = await import('../src/db/schema/identity')
const { journalEntries } = await import('../src/db/schema/progress')
const { getContactDetail, searchContacts } = await import('../src/db/queries/crm')
const { createEntry } = await import('../src/db/queries/journal')

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

const SECRET_WORDS = [
  'mortifying',
  'stepfather',
  'abortion',
  'bankruptcy',
]
const SECRET = `The thing I have never said out loud: ${SECRET_WORDS.join(', ')}.`

const contact = must(
  (
    await db
      .insert(contacts)
      .values({
        email: `privacy-${randomUUID()}@example.test`,
        firstName: 'Private',
        lastName: 'Person',
      })
      .returning()
  )[0],
  'no contact',
)

// Written as SHE would write it, through the real path.
const herself = {
  db,
  actor: {
    kind: 'user' as const,
    userId: randomUUID(),
    contactId: contact.id,
    roles: ['member' as const],
  },
}

await createEntry(herself, {
  contactId: contact.id,
  title: 'Day 2',
  body: SECRET,
  area: 'self',
  source: 'lesson_prompt',
})

// A coach, and an owner. Neither may see a word of it.
const coach = {
  db,
  actor: {
    kind: 'user' as const,
    userId: randomUUID(),
    contactId: randomUUID(),
    roles: ['member' as const, 'coach' as const],
  },
}
const owner = {
  db,
  actor: {
    kind: 'user' as const,
    userId: randomUUID(),
    contactId: randomUUID(),
    roles: ['member' as const, 'owner' as const],
  },
}

function leaks(value: unknown): string | null {
  const serialised = JSON.stringify(value ?? null)
  for (const word of [...SECRET_WORDS, 'never said out loud']) {
    if (serialised.toLowerCase().includes(word.toLowerCase())) return word
  }
  return null
}

console.log('the entry really is stored encrypted:')

await check('the stored row contains none of her words', async () => {
  const [row] = await db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.contactId, contact.id))
  assert.ok(row, 'no entry was written')
  assert.equal(leaks(row.bodyEncrypted), null, 'the body was stored in the clear')
  assert.ok(row.wordCount > 0, 'word count should be stored in the clear')
})

console.log('\nthe admin contact view:')

const detailAsCoach = await getContactDetail(coach, contact.id)
const detailAsOwner = await getContactDetail(owner, contact.id)

await check('a COACH sees the contact but none of her words', () => {
  assert.ok(detailAsCoach, 'staff should be able to open a contact')
  const leaked = leaks(detailAsCoach)
  assert.equal(leaked, null, `the contact view leaked "${leaked}"`)
})

await check('an OWNER sees none of her words either', () => {
  assert.ok(detailAsOwner)
  const leaked = leaks(detailAsOwner)
  assert.equal(leaked, null, `the contact view leaked "${leaked}" to the owner`)
})

await check('no ciphertext is handed to the view at all', () => {
  const serialised = JSON.stringify(detailAsCoach)
  assert.ok(
    !serialised.includes('bodyEncrypted'),
    'the contact view carries the ciphertext column',
  )
})

await check('but it DOES report engagement', () => {
  assert.ok(detailAsCoach)
  assert.equal(detailAsCoach.journal.entries, 1, 'staff should see that she wrote')
  assert.ok(detailAsCoach.journal.words > 0, 'staff should see how much')
  assert.ok(detailAsCoach.journal.lastAt, 'staff should see when')
})

console.log('\nthe contact list:')

await check('searching contacts leaks nothing either', async () => {
  const rows = await searchContacts(coach, { query: 'Private' })
  assert.ok(rows.length >= 1, 'she should be findable')
  const leaked = leaks(rows)
  assert.equal(leaked, null, `the contact list leaked "${leaked}"`)
})

console.log('\nand she can still read her own:')

await check('her own entry decrypts for her', async () => {
  const { listMetadata, readBody } = await import('../src/db/queries/journal')
  const metadata = await listMetadata(herself, contact.id)
  assert.equal(metadata.length, 1)
  const entry = await readBody(herself, metadata[0]!.id)
  assert.ok(entry, 'she could not read her own entry')
  assert.equal(entry.body, SECRET)
})

await check('a coach cannot read it through the journal query either', async () => {
  const { listMetadata, readBody } = await import('../src/db/queries/journal')
  const metadata = await listMetadata(herself, contact.id)
  await assert.rejects(
    () => readBody(coach, metadata[0]!.id),
    'a coach read her journal entry',
  )
})

// -------------------------------------------------------------- teardown ---
await db.delete(contacts).where(eq(contacts.id, contact.id))

console.log(`\nCRM privacy: all ${passed} checks passed`)
process.exit(0)

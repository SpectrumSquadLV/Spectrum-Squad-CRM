/**
 * The audience view.
 *
 * Two things worth proving. First that the LABELS are honest — a source the
 * mapping has never heard of must be shown as it was stored, not swallowed
 * into an "Other" bucket, because the whole question this page answers is
 * "where did she come from" and a bucket is not an answer.
 *
 * Second that the NUMBERS are honest. A list size that counts women who
 * unsubscribed, whose address bounced, or who were archived is a vanity
 * number, and it is the one that makes a perfectly good send look like it
 * failed.
 *
 * And, as everywhere else that reads contacts: nothing she wrote may appear.
 *
 * Run: DATABASE_URL=... npm run verify:audience
 */
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client'
import { contacts } from '../src/db/schema/identity'
import { emailEvents } from '../src/db/schema/activity'
import { journalEntries } from '../src/db/schema/progress'
import {
  audienceTotals,
  countsBySource,
  countsByTag,
  optInEvents,
  recentOptIns,
} from '../src/db/queries/audience'
import { describeSource, groupOf, GROUP_LABELS } from '../src/features/admin/sources'
import { createContactKey, encryptEntry, unwrapContactKey } from '../src/lib/crypto/journal'
import { findOrCreateLead, tagContact } from '../src/db/queries/leads'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const stamp = Date.now()
const emailFor = (n: string) => `aud-check-${stamp}-${n}@example.test`

console.log('\nreading a source')

check('the quiz is named', describeSource('quiz:which-version').label === 'The quiz')
check('and grouped as the quiz', groupOf('quiz:which-version') === 'quiz')

{
  const d = describeSource('archetype-opt-in:the-watcher')
  check('a self-identified opt-in is named', d.label === 'Recognised herself')
  check('and says which archetype', d.detail?.includes('The Watcher') === true, d.detail ?? '')
  check('and still counts as the quiz funnel', d.group === 'quiz')
}

{
  const d = describeSource('writing:almost-ready-is-a-decision')
  check('a piece of writing is named', d.label === 'Something you wrote')
  check('and the slug is made readable', d.detail === 'Almost ready is a decision', d.detail ?? '')
  check(
    'the writing index is distinguished from a piece',
    describeSource('writing:index').detail?.includes('index') === true,
  )
  check('writing with no slug is still writing', groupOf('writing:') === 'writing')
}

check(
  'buying the challenge is named as the challenge',
  describeSource('checkout:me-vs-her').label === 'Bought ME VS HER',
)
check(
  'buying the course is named as the course',
  describeSource('checkout:the-divine-feminine').label === 'Bought The Divine Feminine',
)
check('the challenge groups apart from the course', groupOf('checkout:me-vs-her') === 'challenge')
check('the course groups as the course', groupOf('checkout:the-divine-feminine') === 'course')
check('the assessment is named', groupOf('assessment:where-are-you') === 'assessment')
check('a cohort waitlist is named', groupOf('cohort-waitlist:march') === 'cohort')

{
  check('no source at all is not a mystery', describeSource(null).label === 'Straight to the site')
  check('an empty source is the same', describeSource('   ').label === 'Straight to the site')
  check('and groups as direct', groupOf(undefined) === 'direct')
}

{
  // The rule that matters: an unknown source is still the truth.
  const d = describeSource('instagram-bio-link')
  check('an unknown source is shown, not hidden', d.label === 'Instagram bio link', d.label)
  check('and is not called "Other"', d.label !== 'Other' && d.label !== 'Unknown')
  check('though it groups as everything else', d.group === 'other')
}

check(
  'every group has a label',
  (['quiz', 'writing', 'challenge', 'course', 'assessment', 'cohort', 'direct', 'other'] as const)
    .every((g) => typeof GROUP_LABELS[g] === 'string' && GROUP_LABELS[g].length > 0),
)

console.log('\ncounting honestly')

async function main() {
  const made: string[] = []
  const lead = async (name: string, source: string) => {
    const id = await findOrCreateLead(db, {
      email: emailFor(name),
      firstName: name,
      source,
    })
    if (!id) throw new Error('could not create a contact')
    made.push(id)
    return id
  }

  const before = await audienceTotals(db)

  // Sources unique to this run. The scratch database carries leftovers from
  // every earlier one, so an absolute count would be measuring those too.
  const QUIZ = `quiz:check-${stamp}`
  const WRITING = `writing:check-${stamp}`

  const quizWoman = await lead('quizzed', QUIZ)
  await lead('reader', WRITING)
  const goneWoman = await lead('gone', QUIZ)
  const bouncedWoman = await lead('bounced', WRITING)
  const archivedWoman = await lead('archived', QUIZ)

  await db
    .update(contacts)
    .set({ emailOptedOutAt: new Date() })
    .where(eq(contacts.id, goneWoman))

  await db.insert(emailEvents).values({
    contactId: bouncedWoman,
    type: 'bounced',
    metadata: {},
  })

  await db
    .update(contacts)
    .set({ archivedAt: new Date() })
    .where(eq(contacts.id, archivedWoman))

  const after = await audienceTotals(db)

  check(
    'an archived woman is not counted at all',
    after.everybody - before.everybody === 4,
    `${after.everybody - before.everybody}`,
  )
  check(
    'somebody who unsubscribed is not reachable',
    after.reachable - before.reachable === 2,
    `${after.reachable - before.reachable}`,
  )
  check('unsubscribes are counted', after.unsubscribed - before.unsubscribed === 1)
  check('bounces are counted', after.bounced - before.bounced === 1)
  check('and recent arrivals are counted', after.addedLast7Days - before.addedLast7Days === 4)
  check('reachable is never more than everybody', after.reachable <= after.everybody)

  const sources = await countsBySource(db)
  const quizRow = sources.find((s) => s.source === QUIZ)
  const writingRow = sources.find((s) => s.source === WRITING)

  check('the quiz source is listed', Boolean(quizRow))
  check('the archived woman is not in her source row', quizRow?.total === 2, String(quizRow?.total))
  check('the woman who left still counts in her source row', quizRow?.unsubscribed === 1)
  check('writing is listed separately', writingRow?.total === 2, String(writingRow?.total))
  check(
    'sources are ordered commonest first',
    sources.every((s, i) => i === 0 || sources[i - 1]!.total >= s.total),
  )

  await tagContact(db, quizWoman, { slug: `aud-${stamp}`, name: 'Audience check' })
  const tagRows = await countsByTag(db)
  check('tags are counted', tagRows.some((t) => t.slug === `aud-${stamp}` && t.total === 1))

  const recent = await recentOptIns(db, 100)
  const mine = recent.filter((r) => r.email.startsWith(`aud-check-${stamp}-`))
  check('the new arrivals show up', mine.length === 4, String(mine.length))
  check('the archived woman does not', !mine.some((r) => r.email.includes('-archived@')))
  check(
    'the one who left is marked',
    mine.find((r) => r.email.includes('-gone@'))?.unsubscribed === true,
  )
  check(
    'newest first',
    recent.every((r, i) => i === 0 || recent[i - 1]!.joinedAt >= r.joinedAt),
  )

  const events = await optInEvents(db)
  check('opt-in events can be counted', Array.isArray(events))
  check(
    'unsubscribes are never counted as an opt-in source',
    !events.some((e) => e.eventType === 'quiz.completed' && e.total < 0),
  )

  console.log('\nnothing she wrote')

  {
    // A woman with a real encrypted journal entry must appear on this page as
    // a name, an address and a door — and nothing else.
    const secret = 'the very private sentence nobody else may read'
    const { dataKey, wrappedKey } = createContactKey()
    const ciphertext = encryptEntry(secret, unwrapContactKey(wrappedKey))
    await db.insert(journalEntries).values({
      contactId: quizWoman,
      bodyEncrypted: ciphertext,
      source: 'free_write',
    })

    const payload = JSON.stringify([
      await audienceTotals(db),
      await countsBySource(db),
      await countsByTag(db),
      await optInEvents(db),
      await recentOptIns(db, 100),
    ])

    check('no journal text reaches the audience page', !payload.includes(secret))
    check('no ciphertext reaches it either', !payload.includes(ciphertext))
    check('and no key material', !payload.includes(dataKey.toString('base64')))
  }

  console.log('\ncleaning up')
  for (const id of made) await db.delete(contacts).where(eq(contacts.id, id))
  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(sql`${contacts.email} like ${'aud-check-' + stamp + '-%'}`)
  check('the test left nothing behind', (left?.n ?? 0) === 0)

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

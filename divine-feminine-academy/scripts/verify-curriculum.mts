/**
 * ME VS HER — the curriculum, as structure.
 *
 * The words are not written yet and this does not test them. What it tests is
 * everything that would be silently wrong if somebody edited the seed in a
 * hurry: the wrong number of days, the mirror appearing on the day of rest, a
 * block type that is not in the registry, and — most importantly — a block
 * that collects something painful without being marked sensitive.
 *
 * That last one is the reason this file exists. `isSensitive` is what decides
 * whether her answer is encrypted before it reaches Postgres. A new block
 * added without it would quietly store the worst thing that ever happened to
 * her in the clear, and nothing would look broken.
 *
 * Run: DATABASE_URL=... npm run verify:curriculum
 */
import { readFile } from 'node:fs/promises'
import { asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client'
import { contacts } from '../src/db/schema/identity'
import {
  lessonBlocks,
  lessons,
  modules,
  programVersions,
  programs,
} from '../src/db/schema/programs'
import { enrollments, herPatterns, mirrorSessions } from '../src/db/schema/progress'
import { blockRegistry, getBlock } from '../src/blocks/registry'
import { suggestStatements } from '../src/blocks/types/mirror-declaration/schema'
import { runSideEffects } from '../src/features/challenge/side-effects'

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

const EXPECTED_DAYS = [
  'MEET ME',
  'MEET YOUR PROTECTOR',
  'FOLLOW THE EMOTION',
  'REVIEW THE BELIEF',
  'THE PROBLEM IS YOU',
  'ME VS HER',
  'REST — LET HER LEAD',
]

/** Anything that asks her for something painful must be encrypted. */
const MUST_BE_SENSITIVE = [
  'protector_profile',
  'emotion_trail',
  'belief_review',
  'manifestation_loop',
  'my_part',
  'me_retirement',
  'mirror_declaration',
  'mirror_gaze',
]

const stamp = Date.now()

async function main() {
  console.log('\nthe registry')

  check('every ME VS HER block type is registered', [
    'mirror_gaze',
    'me_portrait',
    'protector_profile',
    'emotion_trail',
    'belief_review',
    'manifestation_loop',
    'celebration',
    'mirror_declaration',
    'me_retirement',
    'callback',
  ].every((t) => Boolean(getBlock(t))))

  for (const type of MUST_BE_SENSITIVE) {
    check(`${type} is encrypted`, getBlock(type)?.isSensitive === true)
  }

  check('display-only blocks ask for nothing', 
    getBlock('callback')?.responseSchema === null &&
    getBlock('celebration')?.responseSchema === null)

  check(
    'the blocks that read her week declare it',
    getBlock('callback')?.resolvesContext === 'her_evidence' &&
      getBlock('celebration')?.resolvesContext === 'her_evidence' &&
      getBlock('mirror_declaration')?.resolvesContext === 'her_evidence',
  )

  check(
    'the mirror records seconds, the retirement retires',
    getBlock('mirror_gaze')?.writesTo?.includes('mirror_sessions') === true &&
      getBlock('me_retirement')?.writesTo?.includes('me_retirement') === true,
  )

  console.log('\nthe seven days')

  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.slug, 'me-vs-her'))
    .limit(1)

  if (!program) {
    console.error('\nno me-vs-her programme — run `npm run seed:challenge`\n')
    process.exit(1)
  }

  const [version] = await db
    .select()
    .from(programVersions)
    .where(eq(programVersions.programId, program.id))
    .orderBy(desc(programVersions.version))
    .limit(1)

  const dayRows = await db
    .select()
    .from(modules)
    .where(eq(modules.versionId, version!.id))
    .orderBy(asc(modules.position))

  check('there are exactly seven days', dayRows.length === 7, String(dayRows.length))
  check('and no eighth', !dayRows.some((d) => d.position > 7))
  check(
    'the titles are the authoritative ones, in order',
    JSON.stringify(dayRows.map((d) => d.title)) === JSON.stringify(EXPECTED_DAYS),
    dayRows.map((d) => d.title).join(' | '),
  )

  // Blocks per day.
  const byDay = new Map<number, string[]>()
  for (const day of dayRows) {
    const rows = await db
      .select({ type: lessonBlocks.type })
      .from(lessonBlocks)
      .innerJoin(lessons, eq(lessons.id, lessonBlocks.lessonId))
      .where(eq(lessons.moduleId, day.id))
      .orderBy(asc(lessonBlocks.position))
    byDay.set(day.position, rows.map((r) => r.type))
  }

  check(
    'every seeded block exists in the registry',
    [...byDay.values()].flat().every((t) => Boolean(getBlock(t))),
    [...byDay.values()].flat().filter((t) => !getBlock(t)).join(', '),
  )

  console.log('\nthe mirror')

  for (let day = 1; day <= 6; day++) {
    check(
      `day ${day} has the mirror`,
      (byDay.get(day) ?? []).includes('mirror_gaze'),
    )
  }

  // The one that matters. Day 7 is rest.
  check(
    'DAY 7 HAS NO MIRROR GAZE',
    !(byDay.get(7) ?? []).includes('mirror_gaze'),
    (byDay.get(7) ?? []).join(', '),
  )
  check('day 7 has the spoken declaration instead', (byDay.get(7) ?? []).includes('mirror_declaration'))
  check('day 7 retires ME', (byDay.get(7) ?? []).includes('me_retirement'))
  check('day 7 reads her week back', (byDay.get(7) ?? []).includes('evidence_review'))
  check(
    'day 7 digs for nothing new',
    !(byDay.get(7) ?? []).some((t) =>
      ['emotion_trail', 'belief_review', 'manifestation_loop', 'protector_profile'].includes(t),
    ),
    (byDay.get(7) ?? []).join(', '),
  )

  console.log('\nthe days in order')

  check('day 1 meets ME', (byDay.get(1) ?? []).includes('me_portrait'))
  check('day 2 meets the protector', (byDay.get(2) ?? []).includes('protector_profile'))
  check('day 3 follows the emotion', (byDay.get(3) ?? []).includes('emotion_trail'))
  check('day 4 reviews the belief', (byDay.get(4) ?? []).includes('belief_review'))
  check('day 5 walks the loop', (byDay.get(5) ?? []).includes('manifestation_loop'))
  check('day 5 ends in celebration', (byDay.get(5) ?? []).includes('celebration'))
  check('day 6 is the signature exercise', (byDay.get(6) ?? []).includes('dual_column_exercise'))
  check('day 6 records an I CHOSE HER', (byDay.get(6) ?? []).includes('her_choice_capture'))
  check(
    'the loop is on day 5, not day 4',
    !(byDay.get(4) ?? []).includes('manifestation_loop'),
  )

  console.log('\nduty of care')

  {
    // The two confronting screens carry framing that is NOT editable copy.
    // A rushed edit in the admin must not be able to remove it.
    const loop = await readFile(
      new URL('../src/blocks/types/manifestation-loop/Member.tsx', import.meta.url),
      'utf8',
    )
    check(
      'the loop screen says she did not cause it',
      loop.includes('not about what you caused'),
    )
    check(
      'and that framing is hard-coded, not config',
      !loop.includes('config.framing') && !loop.includes('config.disclaimer'),
    )

    const myPart = await readFile(
      new URL('../src/blocks/types/my-part/Member.tsx', import.meta.url),
      'utf8',
    )
    check(
      'the problem-is-you screen says the same',
      myPart.includes('You did not cause what was done to you'),
    )
  }

  console.log('\nher declaration, built from her own week')

  {
    const evidence = {
      patterns: [
        { triggerText: 'when nobody notices', currentResponse: 'I go quiet', herResponse: 'I say what I wanted' },
        { triggerText: 'being criticised', currentResponse: 'I defend', herResponse: 'I listen first' },
      ],
      choiceCount: 3,
      choices: [{ situation: 'at work', herResponse: 'I asked for the thing', area: 'money' }],
      returnCount: 1,
      daysCompleted: 6,
      journalEntryCount: 8,
      journalWordCount: 1400,
    }

    const s = suggestStatements(evidence, ['a generic one'])
    check('it uses what HER would do', s.includes('I say what I wanted'))
    check('it uses her real choices', s.includes('I asked for the thing'))
    check('it counts her evidence', s.some((x) => x.includes('3 times')))
    check('her own words come before the generic ones', s.indexOf('a generic one') === s.length - 1)
    /*
     * Only the sentence the generator COMPOSES can be held to this.
     *
     * The first version asserted it of every statement and failed on the
     * fallback text in this very test — which was the fixture being wrong, not
     * the code. Her own material is whatever she wrote, and telling a woman
     * her own sentence is malformed would be worse than any tidiness gained.
     */
    const composed = s.find((x) => x.includes('3 times'))
    check('the sentence it writes itself is first person', /\bI\b/.test(composed ?? ''), composed ?? 'missing')
    check('and it is present tense, ready to be spoken', !/\bwill\b/i.test(composed ?? ''))

    const empty = suggestStatements(undefined, ['fallback one', 'fallback two'])
    check('with nothing of hers it still offers something', empty.length === 2)

    const dupes = suggestStatements(
      {
        ...evidence,
        patterns: [
          { triggerText: 'a', currentResponse: null, herResponse: 'I say what I wanted' },
          { triggerText: 'b', currentResponse: null, herResponse: 'I say what I wanted ' },
        ],
        choices: [],
        choiceCount: 0,
      },
      [],
    )
    check('the same true thing is not said twice', dupes.length === 1, JSON.stringify(dupes))
  }

  console.log('\nretiring ME, and the mirror that records honestly')

  {
    const [contact] = await db
      .insert(contacts)
      .values({ email: `curr-check-${stamp}@example.test`, firstName: 'Ada', timezone: 'UTC' })
      .returning()

    const [enrollment] = await db
      .insert(enrollments)
      .values({
        contactId: contact!.id,
        programId: program.id,
        versionId: version!.id,
        timezoneAtStart: 'UTC',
      })
      .returning()

    const [pattern] = await db
      .insert(herPatterns)
      .values({
        contactId: contact!.id,
        triggerText: 'when nobody notices',
        sourceEnrollmentId: enrollment!.id,
      })
      .returning()

    const [anyBlock] = await db.select().from(lessonBlocks).limit(1)
    const [anyLesson] = await db.select().from(lessons).limit(1)

    const base = {
      db,
      contactId: contact!.id,
      enrollmentId: enrollment!.id,
      programId: program.id,
      lessonId: anyLesson!.id,
      blockId: anyBlock!.id,
    }

    // The mirror, stopped early.
    await runSideEffects({
      ...base,
      definition: getBlock('mirror_gaze')!,
      response: { secondsCompleted: 11, completed: false, secondsAsked: 60 },
    })

    const [session] = await db
      .select()
      .from(mirrorSessions)
      .where(eq(mirrorSessions.contactId, contact!.id))
      .limit(1)

    check('stopping early is still recorded', session?.secondsCompleted === 11)
    check('and is not marked complete', session?.completedAt === null)
    check('what she was asked for is kept too', session?.secondsAsked === 60)

    // Doing it again updates rather than duplicating.
    await runSideEffects({
      ...base,
      definition: getBlock('mirror_gaze')!,
      response: { secondsCompleted: 60, completed: true, secondsAsked: 60 },
    })

    const again = await db
      .select()
      .from(mirrorSessions)
      .where(eq(mirrorSessions.contactId, contact!.id))

    check('going back to it updates the same session', again.length === 1)
    check('and now it is complete', again[0]?.completedAt !== null)
    check('with the longer time', again[0]?.secondsCompleted === 60)

    // Retirement.
    await runSideEffects({
      ...base,
      definition: getBlock('me_retirement')!,
      response: { retire: true, understood: true, loved: true, thanked: true, released: true },
    })

    const [retired] = await db
      .select()
      .from(herPatterns)
      .where(eq(herPatterns.id, pattern!.id))
      .limit(1)

    check('ME is retired', retired?.retiredAt !== null)

    // And it is reversible. Nothing here locks a door behind her.
    await runSideEffects({
      ...base,
      definition: getBlock('me_retirement')!,
      response: { retire: false },
    })

    const [unretired] = await db
      .select()
      .from(herPatterns)
      .where(eq(herPatterns.id, pattern!.id))
      .limit(1)

    check('and it can be undone', unretired?.retiredAt === null)

    await db.delete(contacts).where(eq(contacts.id, contact!.id))
    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(contacts)
      .where(eq(contacts.email, `curr-check-${stamp}@example.test`))
    check('the test left nothing behind', (left?.n ?? 0) === 0)
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

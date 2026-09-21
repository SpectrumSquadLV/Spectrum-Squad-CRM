/**
 * The quiz, end to end, against a real database.
 *
 * The pure scorer is covered by verify:archetypes. This covers everything the
 * scorer cannot: that the server refuses to take the browser's word for the
 * result, that one woman is one contact however many times she takes it, that
 * her segmentation tag lands, and that the event the email sequences hang off
 * carries the archetype.
 *
 * The check that matters most is the forged one. If the browser could name the
 * archetype, every per-archetype email after it would be addressed to somebody
 * who does not exist.
 *
 * Run: DATABASE_URL=... npm run verify:quiz
 */
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client'
// Imported from the concrete modules rather than the barrel: an `export *`
// re-export does not resolve to named ESM bindings under tsx.
import { activityEvents } from '../src/db/schema/activity'
import {
  assessmentAttempts,
  assessmentResponses,
  assessmentResults,
  assessments,
} from '../src/db/schema/assessments'
import { contactTags, contacts, tags } from '../src/db/schema/identity'
import { getPublishedAssessment } from '../src/db/queries/assessments'
import { quizInput, recordQuizSubmission } from '../src/features/quiz/submit'
import { quizQuestions } from '../src/features/quiz/questions'
import {
  scoreArchetypes,
  validateArchetypeVersion,
  type ProtectiveMode,
} from '../src/features/quiz/archetypes'

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

const SLUG = 'which-version'
const stamp = Date.now()
const emailFor = (n: string) => `quiz-check-${stamp}-${n}@example.test`

async function submit(input: {
  email: string
  firstName: string
  answers: Record<string, string>
  slug?: string
}): Promise<{ token?: string; error?: string }> {
  const outcome = await recordQuizSubmission({
    slug: input.slug ?? SLUG,
    firstName: input.firstName,
    email: input.email.trim().toLowerCase(),
    answers: input.answers,
  })
  return outcome.ok ? { token: outcome.token } : { error: outcome.error }
}

/** Answer every question with whichever option most favours `mode`. */
function answersFor(
  questions: { id: string; config: unknown }[],
  mode: ProtectiveMode,
): Record<string, string> {
  const out: Record<string, string> = {}
  questions.forEach((q, i) => {
    const seed = quizQuestions[i]
    if (!seed) return
    const best = [...seed.options].sort(
      (a, b) => (b.weights[mode] ?? 0) - (a.weights[mode] ?? 0),
    )[0]!
    out[q.id] = best.value
  })
  return out
}

async function main() {
  const published = await getPublishedAssessment(db, SLUG)
  if (!published) {
    console.error('no published quiz — run `npm run seed:quiz` first')
    process.exit(1)
  }

  console.log('\nthe seeded quiz')
  check('it is published', Boolean(published.version.publishedAt))
  check('it is an archetype quiz, not a scored one', published.assessment.kind === 'archetype')
  check(
    'every seeded question came back',
    published.questions.length === quizQuestions.length,
  )
  check(
    'every question is a choice question',
    published.questions.every((q) => q.type === 'multiple_choice'),
  )

  console.log('\na woman takes it')

  const email = emailFor('sulk')
  const sulkAnswers = answersFor(published.questions, 'sulk')
  const first = await submit({ email, firstName: 'Ada', answers: sulkAnswers })

  check('it redirects to a result', Boolean(first.token), first.error)
  if (!first.token) {
    console.error('\ncannot continue without a token\n')
    process.exit(1)
  }

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.email, email))
    .limit(1)

  check('she exists as a contact', Boolean(contact))
  check('her source records the quiz', contact?.acquisitionSource === `quiz:${SLUG}`)

  const [attempt] = await db
    .select()
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.resultToken, first.token))
    .limit(1)

  check('the attempt was stored', Boolean(attempt))
  check('the first attempt is a pre', attempt?.timing === 'pre')
  check('the attempt is completed', Boolean(attempt?.completedAt))

  const responses = await db
    .select()
    .from(assessmentResponses)
    .where(eq(assessmentResponses.attemptId, attempt!.id))

  check('every answer was stored', responses.length === quizQuestions.length)

  const [result] = await db
    .select()
    .from(assessmentResults)
    .where(eq(assessmentResults.attemptId, attempt!.id))
    .limit(1)

  check('a result was written', Boolean(result))
  check('the archetype is the one she answered as', result?.archetype === 'sulk', String(result?.archetype))
  check('a scored assessment overall is left null', result?.overallScore === null)

  const shares = (result?.categoryScores ?? {}) as Record<string, number>
  check('all four shares were stored', ['fight', 'flight', 'freeze', 'sulk'].every((m) => typeof shares[m] === 'number'))
  check('her own mode has the largest share', Object.entries(shares).sort((a, b) => b[1] - a[1])[0]?.[0] === 'sulk')

  console.log('\nsegmentation')

  const tagged = await db
    .select({ slug: tags.slug })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(eq(contactTags.contactId, contact!.id))

  check('she was tagged with her archetype', tagged.some((t) => t.slug === 'archetype-the-quiet-storm'), JSON.stringify(tagged))

  const [event] = await db
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.contactId, contact!.id),
        eq(activityEvents.eventType, 'quiz.completed'),
      ),
    )
    .limit(1)

  check('a quiz.completed event was written', Boolean(event))
  const meta = (event?.metadata ?? {}) as Record<string, unknown>
  check('the event carries the archetype for rule matching', meta.archetype === 'sulk')
  check('the event carries the quiz slug', meta.slug === SLUG)

  console.log('\nshe takes it again')

  const fightAnswers = answersFor(published.questions, 'fight')
  const second = await submit({ email, firstName: 'Ada', answers: fightAnswers })
  check('the retake also redirects', Boolean(second.token), second.error)

  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .where(eq(contacts.email, email))

  check('a retake does not create a second woman', counted?.count === 1, String(counted?.count))

  const attempts = await db
    .select()
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.contactId, contact!.id))

  check('a retake is a second attempt, not an edit', attempts.length === 2)
  check('the retake is recorded as a post', attempts.some((a) => a.timing === 'post'))

  const [retakeAttempt] = await db
    .select()
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.resultToken, second.token!))
    .limit(1)

  const [retakeResult] = await db
    .select()
    .from(assessmentResults)
    .where(eq(assessmentResults.attemptId, retakeAttempt!.id))
    .limit(1)

  check('the retake scored differently', retakeResult?.archetype === 'fight', String(retakeResult?.archetype))

  const taggedAfter = await db
    .select({ slug: tags.slug })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(eq(contactTags.contactId, contact!.id))

  // Both tags survive on purpose: which version she used to lead with is
  // history worth keeping, and deleting it would make the retake pointless.
  check('the new archetype tag is added', taggedAfter.some((t) => t.slug === 'archetype-the-commander'))
  check('tagging twice does not duplicate', new Set(taggedAfter.map((t) => t.slug)).size === taggedAfter.length)

  console.log('\nwhat the browser is not allowed to do')

  {
    // Every answer forged to an option value that does not exist.
    const forged = Object.fromEntries(
      published.questions.map((q) => [q.id, 'not-an-option']),
    )
    const r = await submit({ email: emailFor('forged'), firstName: 'Mallory', answers: forged })
    check('answers that are not real options are refused', !r.token && Boolean(r.error), JSON.stringify(r))
  }

  {
    // A result smuggled in alongside the answers. The core takes a typed input
    // with nowhere to put it, and zod strips it before it is ever seen.
    const answers = answersFor(published.questions, 'freeze')
    const parsed = quizInput.safeParse({
      slug: SLUG,
      firstName: 'Mallory',
      email: emailFor('smuggled'),
      answers,
      archetype: 'fight',
      result: 'fight',
    })
    check('a smuggled result does not even parse into the input', parsed.success && !('archetype' in parsed.data))

    const r = parsed.success ? await recordQuizSubmission(parsed.data) : null
    const token = r?.ok ? r.token : undefined

    const [a] = await db
      .select()
      .from(assessmentAttempts)
      .where(eq(assessmentAttempts.resultToken, token ?? 'none'))
      .limit(1)
    const [res] = await db
      .select()
      .from(assessmentResults)
      .where(eq(assessmentResults.attemptId, a?.id ?? '00000000-0000-0000-0000-000000000000'))
      .limit(1)

    check(
      'the stored archetype is the one her answers scored',
      res?.archetype === 'freeze',
      `got ${res?.archetype}`,
    )
  }

  {
    const r = await submit({
      email: emailFor('empty'),
      firstName: 'Ada',
      answers: {},
    })
    check('no answers at all is refused', !r.token && Boolean(r.error))
  }

  {
    const bad = quizInput.safeParse({
      slug: SLUG,
      firstName: 'Ada',
      email: 'not-an-email',
      answers: { a: 'b' },
    })
    check('a bad email is refused before anything is written', !bad.success)

    const noName = quizInput.safeParse({
      slug: SLUG,
      firstName: '   ',
      email: 'ada@example.test',
      answers: { a: 'b' },
    })
    check('a blank name is refused', !noName.success)
  }

  {
    // The scored assessment must not be submittable through the quiz action:
    // it has no weights, so it would store an archetype of nothing.
    const [scored] = await db
      .select({ slug: assessments.slug })
      .from(assessments)
      .where(eq(assessments.kind, 'scored'))
      .limit(1)

    if (scored) {
      const r = await submit({
        email: emailFor('wrong-kind'),
        firstName: 'Ada',
        answers: { whatever: 'a' },
        slug: scored.slug,
      })
      check('a scored assessment is refused by the quiz action', !r.token && Boolean(r.error))
    } else {
      check('a scored assessment is refused by the quiz action (none seeded, skipped)', true)
    }
  }

  {
    const r = await submit({
      email: emailFor('missing'),
      firstName: 'Ada',
      answers: answersFor(published.questions, 'fight'),
      slug: 'no-such-quiz',
    })
    check('an unknown quiz slug is refused', !r.token && Boolean(r.error))
  }

  console.log('\ncleaning up')
  const created = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(sql`${contacts.email} like ${'quiz-check-' + stamp + '-%'}`)

  for (const c of created) {
    await db.delete(contacts).where(eq(contacts.id, c.id))
  }
  const left = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(sql`${contacts.email} like ${'quiz-check-' + stamp + '-%'}`)
  check('the test left no contacts behind', left.length === 0)

  
/* ==========================================================================
   ONE INSTRUMENT: a guaranteed archetype, and where it is loudest.

   Everything below is about the promise that a completed quiz always
   resolves. It used to be able to end in nothing, which is the one outcome a
   woman who answered twelve honest questions must never get.
   ========================================================================== */

console.log('\nevery completed quiz resolves to one of the four')

{
  const q = (id: string, weights: Record<string, number>, areas: Record<string, number>) => ({
    id,
    type: 'multiple_choice' as const,
    config: { options: [{ value: 'a', weights, areas }] },
  })

  // A single answer, carrying a single point.
  const one = scoreArchetypes([q('q1', { sulk: 1 }, { relationships: 1 })], [
    { questionId: 'q1', value: 'a' },
  ])
  check('one answer is enough', one.primary === 'sulk', String(one.primary))
  check('and it is not flagged as a defect', one.degenerate === false)

  // A dead-flat four-way tie.
  const tie = scoreArchetypes(
    [q('q1', { fight: 1, flight: 1, freeze: 1, sulk: 1 }, { herself: 1 })],
    [{ questionId: 'q1', value: 'a' }],
  )
  check('a perfect tie still names one', tie.primary !== null, String(tie.primary))
  check(
    'and names the same one every time',
    scoreArchetypes(
      [q('q1', { fight: 1, flight: 1, freeze: 1, sulk: 1 }, { herself: 1 })],
      [{ questionId: 'q1', value: 'a' }],
    ).primary === tie.primary,
  )

  // A version that cannot score. She still gets a result; it is flagged.
  const dead = scoreArchetypes([q('q1', {}, {})], [{ questionId: 'q1', value: 'a' }])
  check('an unscoreable version still resolves', Boolean(dead.primary))
  check('and is flagged as a defect, not a result', dead.degenerate === true)
  check('while still counting her as having answered', dead.answered === 1)
}

console.log('\nthe tie-break is decided by her answers, not by the list order')

{
  /*
   * Fight and sulk finish level on points. Sulk was the OUTRIGHT choice
   * twice - the single strongest weight in the option she picked - while
   * fight only ever arrived alongside something else. Declaration order
   * would hand this to fight, which is exactly the bias being removed.
   */
  const questions = [
    { id: 'q1', type: 'multiple_choice' as const, config: { options: [{ value: 'a', weights: { sulk: 2 }, areas: { relationships: 2 } }] } },
    { id: 'q2', type: 'multiple_choice' as const, config: { options: [{ value: 'a', weights: { sulk: 2 }, areas: { relationships: 2 } }] } },
    { id: 'q3', type: 'multiple_choice' as const, config: { options: [{ value: 'a', weights: { fight: 2, flight: 2 }, areas: { herself: 2 } }] } },
    { id: 'q4', type: 'multiple_choice' as const, config: { options: [{ value: 'a', weights: { fight: 2, freeze: 2 }, areas: { herself: 2 } }] } },
  ]
  const answers = questions.map((q) => ({ questionId: q.id, value: 'a' }))
  const r = scoreArchetypes(questions, answers)

  const fight = r.tallies.find((t) => t.mode === 'fight')!.points
  const sulk = r.tallies.find((t) => t.mode === 'sulk')!.points
  check('the two are genuinely level on points', fight === sulk, `${fight} vs ${sulk}`)
  check(
    'the one she reached for outright wins',
    r.primary === 'sulk',
    `${r.primary} — declaration order would have said fight`,
  )
}

console.log('\nwhere it is loudest')

{
  const questions = [
    { id: 'q1', type: 'multiple_choice' as const, config: { options: [{ value: 'a', weights: { sulk: 2 }, areas: { money: 3 } }] } },
    { id: 'q2', type: 'multiple_choice' as const, config: { options: [{ value: 'a', weights: { sulk: 2 }, areas: { money: 3, relationships: 1 } }] } },
    { id: 'q3', type: 'multiple_choice' as const, config: { options: [{ value: 'a', weights: { sulk: 2 }, areas: { relationships: 2 } }] } },
  ]
  const r = scoreArchetypes(questions, questions.map((q) => ({ questionId: q.id, value: 'a' })))

  check('the loudest area is named', r.loudest === 'money', String(r.loudest))
  check('all four areas are reported', r.areas.length === 4)
  check(
    'the shares add up to about a hundred',
    Math.abs(r.areas.reduce((n, a) => n + a.share, 0) - 100) <= 2,
    String(r.areas.reduce((n, a) => n + a.share, 0)),
  )
  check(
    'an area nothing touched is zero rather than absent',
    r.areas.find((a) => a.area === 'herself')?.share === 0,
  )
  check(
    'the two halves are independent',
    r.primary === 'sulk' && r.loudest === 'money',
    'how she protects herself and where it costs her are different answers',
  )
}

console.log('\nthe real quiz can produce all four, and can say where')

{
  const problems = validateArchetypeVersion(
    quizQuestions.map((q, i) => ({
      id: `q${i + 1}`,
      type: 'multiple_choice' as const,
      config: { options: q.options },
    })),
  )
  check(
    'the published quiz passes its own publish check',
    problems.length === 0,
    problems.join(' | '),
  )

  // Every archetype must be reachable, and every area must be too.
  for (const mode of ['fight', 'flight', 'freeze', 'sulk'] as const) {
    const answers = quizQuestions.map((q, i) => {
      const best = [...q.options].sort(
        (a, b) => (b.weights[mode] ?? 0) - (a.weights[mode] ?? 0),
      )[0]!
      return { questionId: `q${i + 1}`, value: best.value }
    })
    const r = scoreArchetypes(
      quizQuestions.map((q, i) => ({
        id: `q${i + 1}`,
        type: 'multiple_choice' as const,
        config: { options: q.options },
      })),
      answers,
    )
    check(`a woman can come out as ${mode}`, r.primary === mode, String(r.primary))
    check(`  and ${mode} is told where it is loudest`, r.loudest !== null)
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

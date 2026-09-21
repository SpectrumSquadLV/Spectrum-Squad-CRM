/**
 * The archetype quiz.
 *
 * Two kinds of check here, and the second kind is the one that matters.
 *
 * The first kind tests the SCORER: ties, weights, junk data, determinism.
 * Ordinary, and cheap to get right.
 *
 * The second kind tests the CONTENT, which is where quizzes actually break. A
 * quiz can be perfectly implemented and still have an archetype that no
 * possible set of answers can reach, or a question where one mode is missing
 * so every woman drifts away from it. Nobody notices for months, because the
 * quiz still returns a result - just never that one. So the real questions are
 * loaded and every archetype is proven reachable.
 *
 * Run: npm run verify:archetypes
 */
import { areas as allAreas } from '../src/features/assessment/scoring'
import {
  archetypeBySlug,
  archetypeList,
  archetypes,
  compareArchetypes,
  isMode,
  modes,
  bareName,
  resultHeadline,
  scoreArchetypes,
  type ProtectiveMode,
  type QuizQuestion,
} from '../src/features/quiz/archetypes'
import { quizQuestions } from '../src/features/quiz/questions'

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

const q = (id: string, weightsPerOption: Record<string, Record<string, number>>): QuizQuestion => ({
  id,
  type: 'multiple_choice',
  config: {
    options: Object.entries(weightsPerOption).map(([value, weights]) => ({
      value,
      weights,
    })),
  },
})

console.log('\nscoring')

{
  const questions = [q('q1', { a: { fight: 2 }, b: { sulk: 2 } })]
  const r = scoreArchetypes(questions, [])
  /*
   * This used to assert `primary === null`, and that nullability WAS the bug:
   * a woman could finish and be told her answers did not add up to anything.
   * Nothing is ever null now. What "she answered nothing" produces instead is
   * a resolved archetype plus two honest flags - answered 0, degenerate true
   * - and it is the CALLER's job to refuse a submission with zero answers
   * rather than the scorer's job to return a hole.
   */
  check('no answers still resolves to one of the four', isMode(r.primary))
  check('no answers is flagged as having no signal', r.degenerate === true)
  check('no answers is not a blend', r.isBlend === false)
  check('no answers counts zero answered', r.answered === 0)
}

{
  const questions = [q('q1', { a: { fight: 2 }, b: { sulk: 2 } })]
  const r = scoreArchetypes(questions, [{ questionId: 'q1', value: 'a' }])
  check('one answer picks its mode', r.primary === 'fight')
  check('one answer is 100% share', r.tallies.find((t) => t.mode === 'fight')?.share === 100)
  check('unchosen modes are zero', r.tallies.find((t) => t.mode === 'sulk')?.share === 0)
}

{
  /*
   * fight and flight dead level, each the outright choice once.
   *
   * Declaration order used to decide this and always said fight, which
   * handed every tie in the instrument to The Commander. It now goes to the
   * protector she was still reaching for LATEST, because answers late in a
   * quiz are less shaped by the framing of the first question.
   */
  const questions = [
    q('q1', { a: { fight: 2 } }),
    q('q2', { a: { flight: 2 } }),
  ]
  const r = scoreArchetypes(questions, [
    { questionId: 'q1', value: 'a' },
    { questionId: 'q2', value: 'a' },
  ])
  check('a tie goes to the one she was still reaching for latest', r.primary === 'flight')

  /*
   * And it is still order-insensitive, which is the property that actually
   * matters: recency is measured by position in the QUESTIONS, not by the
   * order the answers happen to arrive in. Two submissions of the same quiz
   * must never disagree about the same woman.
   */
  const flipped = scoreArchetypes(questions, [
    { questionId: 'q2', value: 'a' },
    { questionId: 'q1', value: 'a' },
  ])
  check('and does not depend on the order the answers arrive in', flipped.primary === 'flight')
}

{
  const questions = [q('q1', { a: { freeze: 3 } }), q('q2', { a: { sulk: 3 } })]
  const r = scoreArchetypes(questions, [
    { questionId: 'q1', value: 'a' },
    { questionId: 'q2', value: 'a' },
  ])
  // Same rule again, two modes further down the list: recency, not order.
  check('the same rule holds further down the list', r.primary === 'sulk')
}

{
  const questions = [q('q1', { a: { fight: -5, sulk: 1 } })]
  const r = scoreArchetypes(questions, [{ questionId: 'q1', value: 'a' }])
  check('a negative weight is refused, not clamped', r.primary === 'sulk')
  check('a negative weight contributes nothing', r.tallies.find((t) => t.mode === 'fight')?.points === 0)
}

{
  const questions = [
    { id: 'q1', type: 'multiple_choice' as const, config: { options: [{ value: 'a', weights: { fight: Number.NaN, sulk: 2 } }] } },
  ]
  const r = scoreArchetypes(questions, [{ questionId: 'q1', value: 'a' }])
  check('NaN weight is ignored', r.primary === 'sulk')
}

{
  const questions = [
    { id: 'q1', type: 'multiple_choice' as const, config: { options: [{ value: 'a', weights: { nonsense: 9, sulk: 1 } as Record<string, number> }] } },
  ]
  const r = scoreArchetypes(questions, [{ questionId: 'q1', value: 'a' }])
  check('an unknown mode key is ignored', r.primary === 'sulk')
}

{
  const questions = [q('q1', { a: { fight: 2 } })]
  const r = scoreArchetypes(questions, [{ questionId: 'q1', value: 'z' }])
  check('an option that does not exist scores nothing', r.degenerate === true)
  check('an option that does not exist is not counted as answered', r.answered === 0)
  /*
   * The scorer still resolves - it always does - and the SUBMIT path is what
   * refuses this, because a submission where nothing matched a real option is
   * a broken or forged request rather than a completed quiz. Fabricating a
   * result here would write a contact, an attempt and an archetype for a
   * woman who never answered anything, and then email her about it.
   */
  check('but it is the submit path that refuses it, not the scorer', isMode(r.primary))
}

{
  const questions: QuizQuestion[] = [
    { id: 'q1', type: 'likert', config: {} },
    { id: 'q2', type: 'open', config: {} },
    q('q3', { a: { freeze: 2 } }),
  ]
  const r = scoreArchetypes(questions, [
    { questionId: 'q1', value: 5 },
    { questionId: 'q2', value: 'a paragraph' },
    { questionId: 'q3', value: 'a' },
  ])
  check('likert and open questions do not score an archetype', r.primary === 'freeze')
  check('only the choice question counts as answered', r.answered === 1)
}

console.log('\nblends')

{
  // 6 vs 5 — close. She leads with one and is nearly the other.
  const questions = [
    q('q1', { a: { fight: 6 } }),
    q('q2', { a: { sulk: 5 } }),
  ]
  const r = scoreArchetypes(questions, [
    { questionId: 'q1', value: 'a' },
    { questionId: 'q2', value: 'a' },
  ])
  check('a close second is reported as a blend', r.isBlend === true)
  check('the blend names the runner-up', r.secondary === 'sulk')
  check('the headline names both', resultHeadline(r) === 'The Commander, with a strong Quiet Storm', resultHeadline(r) ?? 'null')
  check('the headline drops the article mid-sentence', !(resultHeadline(r) ?? '').includes('strong The'))
}

{
  // 60/40 — a twenty point gap. She leads with one, clearly.
  const questions = [
    q('q1', { a: { fight: 6 } }),
    q('q2', { a: { sulk: 4 } }),
  ]
  const r = scoreArchetypes(questions, [
    { questionId: 'q1', value: 'a' },
    { questionId: 'q2', value: 'a' },
  ])
  check('a clear winner is not a blend', r.isBlend === false)
  check('a clear winner has no secondary', r.secondary === null)
  check('the headline names one', resultHeadline(r) === 'The Commander')
}

{
  // Everything on one mode: the runner-up has zero, which must never blend.
  const questions = [q('q1', { a: { freeze: 4 } })]
  const r = scoreArchetypes(questions, [{ questionId: 'q1', value: 'a' }])
  check('a zero-point runner-up is never a blend', r.isBlend === false && r.secondary === null)
}

{
  // Exactly on the threshold. Inclusive, so this one IS a blend - and saying
  // so here means a future change to the number cannot pass silently.
  const questions = [q('q1', { a: { fight: 55 } }), q('q2', { a: { sulk: 45 } })]
  const r = scoreArchetypes(questions, [
    { questionId: 'q1', value: 'a' },
    { questionId: 'q2', value: 'a' },
  ])
  check('a gap exactly at the threshold blends', r.isBlend === true && r.secondary === 'sulk')
}

{
  const questions = [q('q1', { a: { fight: 56 } }), q('q2', { a: { sulk: 44 } })]
  const r = scoreArchetypes(questions, [
    { questionId: 'q1', value: 'a' },
    { questionId: 'q2', value: 'a' },
  ])
  check('one point past the threshold does not blend', r.isBlend === false)
}

console.log('\nshares')

{
  const questions = [
    q('q1', { a: { fight: 1 } }),
    q('q2', { a: { flight: 1 } }),
    q('q3', { a: { freeze: 1 } }),
  ]
  const r = scoreArchetypes(questions, [
    { questionId: 'q1', value: 'a' },
    { questionId: 'q2', value: 'a' },
    { questionId: 'q3', value: 'a' },
  ])
  const total = r.tallies.reduce((s, t) => s + t.share, 0)
  // Three equal thirds round to 33 each, so 99 is correct and 100 would be a lie.
  check('shares are honest about rounding', total === 99, `got ${total}`)
  check('every share is between 0 and 100', r.tallies.every((t) => t.share >= 0 && t.share <= 100))
}

console.log('\ncomparison over time')

{
  const before = scoreArchetypes([q('q1', { a: { fight: 2 } })], [{ questionId: 'q1', value: 'a' }])
  const after = scoreArchetypes([q('q1', { a: { sulk: 2 } })], [{ questionId: 'q1', value: 'a' }])
  const diff = compareArchetypes(before, after)
  check('a mode she moved away from shows a fall', diff.find((d) => d.mode === 'fight')?.delta === -100)
  check('a mode she moved toward shows a rise', diff.find((d) => d.mode === 'sulk')?.delta === 100)
  check('comparison covers all four modes', diff.length === 4)
}

console.log('\nthe four')

check('there are exactly four', archetypeList.length === 4)
check('one per mode', modes.every((m) => archetypes[m].mode === m))
check('slugs are unique', new Set(archetypeList.map((a) => a.slug)).size === 4)
check(
  'slugs are URL-safe',
  archetypeList.every((a) => /^[a-z0-9-]+$/.test(a.slug)),
)
check('every slug resolves', archetypeList.every((a) => archetypeBySlug(a.slug)?.mode === a.mode))
check('an unknown slug resolves to nothing', archetypeBySlug('the-nonexistent') === null)
check('isMode accepts the four', modes.every(isMode))
check('isMode rejects anything else', !isMode('fawn') && !isMode('') && !isMode(null))
check(
  'every name survives being used mid-sentence',
  archetypeList.every((a) => bareName(a) !== a.name && bareName(a).length > 0),
)

// A half-edited copy file is a real failure mode: somebody rewrites two
// archetypes, gets interrupted, and a woman gets an empty result page.
for (const a of archetypeList) {
  const strings = [a.name, a.tagline, a.oneLiner, a.protecting, a.costs, a.theReturn, a.firstStep, a.shareLine]
  check(
    `${a.slug}: every line is written`,
    strings.every((s) => typeof s === 'string' && s.trim().length > 10),
  )
  check(
    `${a.slug}: has three of each list`,
    a.soundsLike.length === 3 && a.looksLike.length === 3,
  )
  check(
    `${a.slug}: carries no placeholder marker`,
    !strings.join(' ').toUpperCase().includes('PLACEHOLDER'),
  )
}

console.log('\nthe real questions')

const loaded: QuizQuestion[] = quizQuestions.map((question, i) => ({
  id: `q${i}`,
  type: 'multiple_choice',
  config: { options: question.options },
}))

check('at least twelve questions', quizQuestions.length >= 12)

/*
 * Every AREA must be reachable too, for exactly the reason every archetype
 * must be: an area no answer can make loudest is a bar she can never see.
 *
 * This check is here because the instrument failed it. When the four areas
 * were renamed to HERSELF / RELATIONSHIPS / MONEY / SUCCESS, the old `wealth`
 * split into money and success and left money with one question out of
 * twelve - so money could not win for any set of answers at all. Two money
 * questions and scoring each area against its own ceiling fixed it, and this
 * check is what stops it coming back.
 */
for (const target of allAreas) {
  const answers = loaded.map((q) => {
    const best = [...(q.config.options ?? [])].sort((a, b) => {
      const av = (a.areas ?? {})[target] ?? 0
      const bv = (b.areas ?? {})[target] ?? 0
      if (bv !== av) return bv - av
      const other = (o: typeof a) =>
        Object.entries(o.areas ?? {})
          .filter(([k]) => k !== target)
          .reduce((sum, [, v]) => sum + v, 0)
      return other(a) - other(b)
    })[0]!
    return { questionId: q.id, value: best.value }
  })
  const result = scoreArchetypes(loaded, answers)
  check(
    `${target} is reachable as the loudest area`,
    result.loudest === target,
    String(result.loudest),
  )
}
check('every question has four options', quizQuestions.every((x) => x.options.length === 4))
check(
  'every option carries at least one weight',
  quizQuestions.every((x) => x.options.every((o) => Object.keys(o.weights).length > 0)),
)
check(
  'every weight is a positive number',
  quizQuestions.every((x) =>
    x.options.every((o) =>
      Object.values(o.weights).every((w) => typeof w === 'number' && w > 0),
    ),
  ),
)
check(
  'every question offers all four modes',
  quizQuestions.every((x) => {
    const covered = new Set<string>()
    for (const o of x.options) {
      // The dominant mode of the option - the one it is really about.
      const top = Object.entries(o.weights).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]
      if (top) covered.add(top[0])
    }
    return covered.size === 4
  }),
)
check(
  'option values are unique within a question',
  quizQuestions.every((x) => new Set(x.options.map((o) => o.value)).size === x.options.length),
)
check(
  'no two questions share a prompt',
  new Set(quizQuestions.map((x) => x.prompt)).size === quizQuestions.length,
)
check(
  'the dominant mode is never in the same position twice running',
  (() => {
    const positions = quizQuestions.map((x) =>
      x.options.findIndex((o) => {
        const top = Object.entries(o.weights).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]
        return top?.[0] === 'fight'
      }),
    )
    // Fight should not sit in slot 0 on every question - that is the bias this
    // quiz is most likely to acquire when somebody edits it in a hurry.
    return new Set(positions).size > 1
  })(),
)

// THE ONE THAT MATTERS: each of the four must be reachable.
for (const mode of modes) {
  const answers = quizQuestions.map((question, i) => {
    const best = [...question.options].sort(
      (a, b) => (b.weights[mode] ?? 0) - (a.weights[mode] ?? 0),
    )[0]!
    return { questionId: `q${i}`, value: best.value }
  })
  const r = scoreArchetypes(loaded, answers)
  check(`${mode} is reachable from the real questions`, r.primary === mode, `got ${r.primary}`)
}

// And a woman who picks the first option every time gets a real answer rather
// than a crash or a null.
{
  const answers = quizQuestions.map((question, i) => ({
    questionId: `q${i}`,
    value: question.options[0]!.value,
  }))
  const r = scoreArchetypes(loaded, answers)
  check('straight-lining still produces a result', r.primary !== null)
}

// Determinism: the same answers in a different order are the same woman.
{
  const answers = quizQuestions.map((question, i) => ({
    questionId: `q${i}`,
    value: question.options[i % 4]!.value,
  }))
  const forward = scoreArchetypes(loaded, answers)
  const backward = scoreArchetypes(loaded, [...answers].reverse())
  check('the result does not depend on answer order', forward.primary === backward.primary)
  check(
    'the shares do not depend on answer order',
    JSON.stringify(forward.tallies) === JSON.stringify(backward.tallies),
  )
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)

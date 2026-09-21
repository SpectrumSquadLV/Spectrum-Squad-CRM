/**
 * Assessment scoring.
 *
 * A score a woman reads about herself has to be right. These cover the parts
 * that are easy to get quietly wrong: reverse-scored questions, unanswered
 * areas, open questions that must not count, and the pre/post comparison.
 *
 * Run: npm run verify:scoring
 */
import assert from 'node:assert/strict'
import {
  compare,
  loudestArea,
  normaliseAnswer,
  scoreAssessment,
  type ScorableQuestion,
} from '../src/features/assessment/scoring'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok   ${name}`)
}

const likert = (
  id: string,
  area: ScorableQuestion['area'],
  reverseScored = false,
): ScorableQuestion => ({
  id,
  type: 'likert',
  area,
  config: { min: 1, max: 5, reverseScored },
})

console.log('normalising:')

check('a likert answer maps onto 0-100', () => {
  const q = likert('q', 'herself')
  assert.equal(normaliseAnswer(q, 1), 0)
  assert.equal(normaliseAnswer(q, 3), 0.5)
  assert.equal(normaliseAnswer(q, 5), 1)
})

check('a REVERSE-scored question inverts', () => {
  const q = likert('q', 'herself', true)
  assert.equal(normaliseAnswer(q, 1), 1)
  assert.equal(normaliseAnswer(q, 5), 0)
})

check('an open question never scores', () => {
  const q: ScorableQuestion = { id: 'q', type: 'open', area: 'herself', config: {} }
  assert.equal(normaliseAnswer(q, 'a long honest answer'), null)
})

check('an unanswered question scores null, not zero', () => {
  const q = likert('q', 'herself')
  assert.equal(normaliseAnswer(q, undefined), null)
  assert.equal(normaliseAnswer(q, ''), null)
  assert.equal(normaliseAnswer(q, null), null)
})

check('an out-of-range answer is clamped, not discarded', () => {
  const q = likert('q', 'herself')
  assert.equal(normaliseAnswer(q, 9), 1)
  assert.equal(normaliseAnswer(q, -4), 0)
})

check('multiple choice scores from its options', () => {
  const q: ScorableQuestion = {
    id: 'q',
    type: 'multiple_choice',
    area: 'relationships',
    config: {
      options: [
        { value: 'never', score: 0 },
        { value: 'sometimes', score: 1 },
        { value: 'always', score: 2 },
      ],
    },
  }
  assert.equal(normaliseAnswer(q, 'never'), 0)
  assert.equal(normaliseAnswer(q, 'sometimes'), 0.5)
  assert.equal(normaliseAnswer(q, 'always'), 1)
  assert.equal(normaliseAnswer(q, 'nonsense'), null)
})

console.log('\nscoring a whole assessment:')

const questions: ScorableQuestion[] = [
  likert('s1', 'herself'),
  likert('s2', 'herself', true),
  likert('l1', 'relationships'),
  likert('w1', 'money'),
  { id: 'o1', type: 'open', area: 'success', config: {} },
]

check('areas score independently', () => {
  const result = scoreAssessment(questions, [
    { questionId: 's1', value: 5 },
    { questionId: 's2', value: 1 },
    { questionId: 'l1', value: 3 },
    { questionId: 'w1', value: 1 },
  ])
  const self = result.byArea.find((a) => a.area === 'herself')!
  assert.equal(self.score, 100, 'reverse-scored 1 should read as high')
  assert.equal(result.byArea.find((a) => a.area === 'relationships')!.score, 50)
  assert.equal(result.byArea.find((a) => a.area === 'money')!.score, 0)
})

check('an area she answered nothing in reads null, not zero', () => {
  const result = scoreAssessment(questions, [{ questionId: 's1', value: 5 }])
  assert.equal(result.byArea.find((a) => a.area === 'success')!.score, null)
  assert.equal(result.byArea.find((a) => a.area === 'relationships')!.score, null)
})

check('open questions are excluded from the scorable count', () => {
  const result = scoreAssessment(questions, [])
  assert.equal(result.scorable, 4, 'the open question should not be counted')
  assert.equal(result.answered, 0)
  assert.equal(result.overall, null)
})

check('the overall score averages only what she answered', () => {
  const result = scoreAssessment(questions, [
    { questionId: 's1', value: 5 },
    { questionId: 'l1', value: 1 },
  ])
  assert.equal(result.overall, 50)
  assert.equal(result.answered, 2)
})

check('the loudest area is her lowest score', () => {
  const result = scoreAssessment(questions, [
    { questionId: 's1', value: 5 },
    { questionId: 'l1', value: 4 },
    { questionId: 'w1', value: 1 },
  ])
  assert.equal(loudestArea(result), 'money')
})

check('with nothing answered there is no loudest area', () => {
  assert.equal(loudestArea(scoreAssessment(questions, [])), null)
})

console.log('\npre and post:')

check('the comparison reports change in points', () => {
  const pre = scoreAssessment(questions, [
    { questionId: 's1', value: 2 },
    { questionId: 'w1', value: 1 },
  ])
  const post = scoreAssessment(questions, [
    { questionId: 's1', value: 4 },
    { questionId: 'w1', value: 4 },
  ])
  const diff = compare(pre, post)
  assert.equal(diff.byArea.find((a) => a.area === 'herself')!.delta, 50)
  assert.equal(diff.byArea.find((a) => a.area === 'money')!.delta, 75)
  assert.equal(diff.overall.delta, 62)
})

check('an area missing from either side has no delta, not a fake zero', () => {
  const pre = scoreAssessment(questions, [{ questionId: 's1', value: 3 }])
  const post = scoreAssessment(questions, [
    { questionId: 's1', value: 5 },
    { questionId: 'l1', value: 5 },
  ])
  const diff = compare(pre, post)
  assert.equal(diff.byArea.find((a) => a.area === 'relationships')!.delta, null)
  assert.equal(diff.byArea.find((a) => a.area === 'success')!.delta, null)
})

console.log(`\nscoring: all ${passed} checks passed`)

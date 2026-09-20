/**
 * Certificate eligibility.
 *
 * The failure modes that matter: handing a certificate to somebody who has
 * done nothing, and withholding one from somebody who has done everything.
 *
 * Run: npm run verify:certificates
 */
import assert from 'node:assert/strict'
import {
  certificateNumber,
  evaluateEligibility,
  evaluateRequirement,
  type Progress,
  type Requirement,
} from '../src/features/certificates/requirements'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok   ${name}`)
}

const done: Progress = {
  lessonsTotal: 7,
  lessonsCompleted: 7,
  requiredBlocksTotal: 6,
  requiredBlocksAnswered: 6,
  postAssessmentSubmitted: true,
  herChoicesLogged: 12,
  herCodeFinalized: true,
}

const nothing: Progress = {
  lessonsTotal: 7,
  lessonsCompleted: 0,
  requiredBlocksTotal: 6,
  requiredBlocksAnswered: 0,
  postAssessmentSubmitted: false,
  herChoicesLogged: 0,
  herCodeFinalized: false,
}

const all: Requirement[] = [
  { requirementType: 'lessons_completed_pct', threshold: 100 },
  { requirementType: 'required_blocks_answered', threshold: 0 },
  { requirementType: 'her_code_finalized', threshold: 0 },
]

console.log('individual rules:')

check('completing every day satisfies the percentage rule', () => {
  const c = evaluateRequirement(
    { requirementType: 'lessons_completed_pct', threshold: 100 },
    done,
  )
  assert.equal(c.met, true)
})

check('a programme with NO lessons is not 100% complete', () => {
  const c = evaluateRequirement(
    { requirementType: 'lessons_completed_pct', threshold: 100 },
    { ...nothing, lessonsTotal: 0, lessonsCompleted: 0 },
  )
  assert.equal(c.met, false, 'zero of zero must not award a certificate')
})

check('a partial finish below the threshold fails', () => {
  const c = evaluateRequirement(
    { requirementType: 'lessons_completed_pct', threshold: 100 },
    { ...done, lessonsCompleted: 6 },
  )
  assert.equal(c.met, false)
  assert.match(c.detail, /86%/)
})

check('a threshold below 100 allows a woman to miss one', () => {
  const c = evaluateRequirement(
    { requirementType: 'lessons_completed_pct', threshold: 80 },
    { ...done, lessonsCompleted: 6 },
  )
  assert.equal(c.met, true)
})

check('required exercises must all be answered', () => {
  assert.equal(
    evaluateRequirement({ requirementType: 'required_blocks_answered', threshold: 0 }, done).met,
    true,
  )
  assert.equal(
    evaluateRequirement(
      { requirementType: 'required_blocks_answered', threshold: 0 },
      { ...done, requiredBlocksAnswered: 5 },
    ).met,
    false,
  )
})

check('a programme with no required exercises satisfies that rule', () => {
  const c = evaluateRequirement(
    { requirementType: 'required_blocks_answered', threshold: 0 },
    { ...nothing, requiredBlocksTotal: 0 },
  )
  assert.equal(c.met, true)
})

check('the HER choices rule counts', () => {
  assert.equal(
    evaluateRequirement({ requirementType: 'her_choices_logged', threshold: 10 }, done).met,
    true,
  )
  assert.equal(
    evaluateRequirement({ requirementType: 'her_choices_logged', threshold: 20 }, done).met,
    false,
  )
})

console.log('\neligibility overall:')

check('doing everything earns it', () => {
  const result = evaluateEligibility(all, done)
  assert.equal(result.eligible, true)
  assert.equal(result.outstanding.length, 0)
})

check('doing nothing does not', () => {
  const result = evaluateEligibility(all, nothing)
  assert.equal(result.eligible, false)
  assert.equal(result.outstanding.length, 3)
})

check('ONE outstanding requirement is enough to withhold it', () => {
  const result = evaluateEligibility(all, { ...done, herCodeFinalized: false })
  assert.equal(result.eligible, false)
  assert.equal(result.outstanding.length, 1)
  assert.equal(result.outstanding[0]!.requirementType, 'her_code_finalized')
})

check('NO configured requirements means no certificate, not a free one', () => {
  const result = evaluateEligibility([], done)
  assert.equal(result.eligible, false, 'silence must not mean yes')
})

check('what is left is reported so she can be told', () => {
  const result = evaluateEligibility(all, { ...done, lessonsCompleted: 3 })
  assert.equal(result.outstanding.length, 1)
  assert.match(result.outstanding[0]!.detail, /43%/)
})

console.log('\nnumbering:')

check('certificate numbers are padded and readable', () => {
  assert.equal(certificateNumber(1, 2026), 'DFA-2026-000001')
  assert.equal(certificateNumber(123, 2026), 'DFA-2026-000123')
  assert.equal(certificateNumber(999999, 2027), 'DFA-2027-999999')
})

console.log(`\ncertificates: all ${passed} checks passed`)

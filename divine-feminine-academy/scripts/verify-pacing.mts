/**
 * The drip pacing rules.
 *
 * A woman who starts at 11pm must get Day 2 the next MORNING, not the next
 * night. Getting this wrong makes a "daily" practice drift later every day
 * until she drops out, so it is worth proving rather than assuming.
 *
 * Run: npm run verify:pacing
 */
import assert from 'node:assert/strict'
import {
  calendarDaysBetween,
  computeUnlockState,
  isDayUnlocked,
  nextUnlockAt,
  safeTimeZone,
  type UnlockInput,
} from '../src/features/challenge/pacing'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok   ${name}`)
}

const LA = 'America/Los_Angeles'
const base: UnlockInput = {
  pacing: 'drip',
  startedAt: new Date('2026-03-02T12:00:00Z'),
  now: new Date('2026-03-02T12:00:00Z'),
  timeZone: LA,
  durationDays: 7,
  allowEarlyUnlock: false,
  highestCompletedDay: 0,
}

console.log('drip pacing:')

check('day 1 is open the moment she starts', () => {
  const s = computeUnlockState(base)
  assert.equal(s.unlockedThrough, 1)
  assert.equal(s.currentDay, 1)
  assert.equal(s.nextUnlockDay, 2)
})

check('starting at 11pm still gives Day 2 the next MORNING', () => {
  // 2026-03-02 23:00 in Los Angeles is 2026-03-03 07:00 UTC.
  const startedAt = new Date('2026-03-03T07:00:00Z')
  // The next morning, 8am on the 3rd in Los Angeles.
  const now = new Date('2026-03-03T16:00:00Z')
  const s = computeUnlockState({ ...base, startedAt, now })
  assert.equal(s.unlockedThrough, 2, 'she should have Day 2 nine hours later')
})

check('the same nine hours WITHIN one civil day unlocks nothing new', () => {
  const startedAt = new Date('2026-03-02T16:00:00Z') // 8am LA
  const now = new Date('2026-03-03T01:00:00Z') // 5pm LA, same day
  const s = computeUnlockState({ ...base, startedAt, now })
  assert.equal(s.unlockedThrough, 1)
})

check('days accumulate one per calendar day', () => {
  const s = computeUnlockState({
    ...base,
    now: new Date('2026-03-05T12:00:00Z'),
  })
  assert.equal(s.unlockedThrough, 4)
})

check('unlocking stops at the length of the programme', () => {
  const s = computeUnlockState({
    ...base,
    now: new Date('2026-04-02T12:00:00Z'),
    highestCompletedDay: 3,
  })
  assert.equal(s.unlockedThrough, 7)
  assert.equal(s.nextUnlockDay, null)
})

check('spring-forward does not skip or repeat a day', () => {
  // US daylight saving begins 2026-03-08. That civil day is 23 hours long.
  const startedAt = new Date('2026-03-07T20:00:00Z') // 12pm LA, Mar 7
  const now = new Date('2026-03-09T19:00:00Z') // 12pm LA, Mar 9
  assert.equal(calendarDaysBetween(startedAt, now, LA), 2)
  const s = computeUnlockState({ ...base, startedAt, now })
  assert.equal(s.unlockedThrough, 3)
})

check('autumn-back does not skip or repeat a day', () => {
  // Daylight saving ends 2026-11-01. That civil day is 25 hours long.
  const startedAt = new Date('2026-10-31T19:00:00Z') // 12pm LA, Oct 31
  const now = new Date('2026-11-02T20:00:00Z') // 12pm LA, Nov 2
  assert.equal(calendarDaysBetween(startedAt, now, LA), 2)
})

check('her timezone decides, not the server', () => {
  // 2026-03-03T04:00Z is still Mar 2 in Los Angeles but already Mar 3 in Tokyo.
  const startedAt = new Date('2026-03-02T12:00:00Z')
  const now = new Date('2026-03-03T04:00:00Z')
  assert.equal(calendarDaysBetween(startedAt, now, LA), 0)
  assert.equal(calendarDaysBetween(startedAt, now, 'Asia/Tokyo'), 1)
})

console.log('\nearly unlock and other pacings:')

check('allowEarlyUnlock opens the whole programme', () => {
  const s = computeUnlockState({ ...base, allowEarlyUnlock: true })
  assert.equal(s.unlockedThrough, 7)
  assert.ok(isDayUnlocked(7, s))
})

check('immediate pacing opens the whole programme', () => {
  const s = computeUnlockState({ ...base, pacing: 'immediate' })
  assert.equal(s.unlockedThrough, 7)
})

check('a cohort opens nothing before it starts', () => {
  const s = computeUnlockState({
    ...base,
    pacing: 'cohort',
    cohortStartsAt: new Date('2026-04-01T12:00:00Z'),
  })
  assert.equal(s.unlockedThrough, 0)
  assert.ok(!isDayUnlocked(1, s))
})

check('a cohort drips once it has started', () => {
  const s = computeUnlockState({
    ...base,
    pacing: 'cohort',
    cohortStartsAt: new Date('2026-03-01T12:00:00Z'),
    now: new Date('2026-03-03T12:00:00Z'),
  })
  assert.equal(s.unlockedThrough, 3)
})

console.log('\nwhere she lands:')

check('a woman who falls behind lands on her next day, not a locked door', () => {
  // Away for a week: five days have unlocked, she finished only one.
  const s = computeUnlockState({
    ...base,
    now: new Date('2026-03-06T12:00:00Z'),
    highestCompletedDay: 1,
  })
  assert.equal(s.unlockedThrough, 5)
  assert.equal(s.currentDay, 2, 'she resumes at Day 2, not Day 5')
  assert.ok(isDayUnlocked(s.currentDay, s))
})

check('currentDay is never past what has unlocked', () => {
  for (let day = 0; day < 10; day++) {
    for (let elapsed = 0; elapsed < 10; elapsed++) {
      const s = computeUnlockState({
        ...base,
        now: new Date(Date.UTC(2026, 2, 2 + elapsed, 12)),
        highestCompletedDay: day,
      })
      assert.ok(
        s.currentDay <= Math.max(s.unlockedThrough, 1),
        `day=${day} elapsed=${elapsed} landed on a locked day`,
      )
      assert.ok(s.currentDay >= 1)
    }
  }
})

check('finishing every day reports complete', () => {
  const s = computeUnlockState({
    ...base,
    now: new Date('2026-03-20T12:00:00Z'),
    highestCompletedDay: 7,
  })
  assert.equal(s.isComplete, true)
  assert.equal(s.nextUnlockDay, null)
})

console.log('\nrobustness:')

check('a nonsense timezone falls back instead of throwing', () => {
  assert.equal(safeTimeZone('Not/AZone'), 'UTC')
  const s = computeUnlockState({ ...base, timeZone: 'Not/AZone' })
  assert.equal(s.currentDay, 1)
})

check('the next unlock is the next midnight in HER timezone', () => {
  const now = new Date('2026-03-03T16:00:00Z') // 8am LA
  const at = nextUnlockAt(now, LA)
  assert.ok(at > now)
  const civil = new Intl.DateTimeFormat('en-CA', {
    timeZone: LA,
    hour: '2-digit',
    hour12: false,
  }).format(at)
  assert.equal(Number(civil), 0, 'should land on midnight in Los Angeles')
  assert.equal(calendarDaysBetween(now, at, LA), 1)
})

console.log(`\npacing: all ${passed} checks passed`)

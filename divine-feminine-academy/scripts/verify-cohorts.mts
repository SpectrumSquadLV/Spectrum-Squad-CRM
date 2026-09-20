/**
 * Live cohorts.
 *
 * UNFINISHED AND UNREACHABLE. There is no public page, no admin and no email
 * for any of this yet — it is committed because the container it was built in
 * is disposable, not because it is done. See the note at the top of the
 * cohorts section in GROWTH.md.
 *
 * What IS finished is the window state machine, and it is worth testing now
 * rather than later because every awkward case in it is a way to lie to a
 * woman: a countdown to a moment that has passed, a Join button on a room
 * that shut, a "2 seats left" on a cohort with no capacity set.
 *
 * The two regression checks at the end are for faults this work exposed in
 * code that already shipped. Those are real today, cohorts or no cohorts.
 *
 * Run: DATABASE_URL=... npm run verify:cohorts
 */
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client'
import { contacts, profiles } from '../src/db/schema/identity'
import {
  cohorts,
  lessons,
  modules,
  programVersions,
  programs,
} from '../src/db/schema/programs'
import { enrollments } from '../src/db/schema/progress'
import {
  cohortWindow,
  doorsCloseAt,
  endsAtOrDerived,
  nextSession,
  sessionIsLive,
  urgencyLine,
  type CohortWindowInput,
} from '../src/features/cohorts/window'
import { pacingTimeZone } from '../src/db/queries/challenge'
import { sendDayReminders } from '../src/features/automation/jobs'

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

const HOUR = 3_600_000
const DAY = 86_400_000
const now = new Date('2026-03-10T12:00:00Z')

const base = (over: Partial<CohortWindowInput> = {}): CohortWindowInput => ({
  status: 'scheduled',
  startsAt: new Date(now.getTime() + 14 * DAY),
  endsAt: null,
  timezone: 'America/Los_Angeles',
  enrollmentOpensAt: null,
  enrollmentClosesAt: null,
  capacity: null,
  seatsTaken: 0,
  durationDays: 7,
  now,
  ...over,
})

console.log('\nwhether there is a page at all')

check('a draft is not public', !cohortWindow(base({ status: 'draft' })).isPublic)
check('a draft cannot be bought', !cohortWindow(base({ status: 'draft' })).canEnroll)
check('a cancelled cohort is not public', !cohortWindow(base({ status: 'cancelled' })).isPublic)
check('a cancelled cohort cannot be bought', !cohortWindow(base({ status: 'cancelled' })).canEnroll)
check('a scheduled cohort is public', cohortWindow(base()).isPublic)

console.log('\nthe doors')

{
  // No explicit open date: the doors are open until it starts.
  const w = cohortWindow(base())
  check('with no window set, the doors are open', w.canEnroll)
  check('and they count down to the start', w.countdownTo?.getTime() === base().startsAt.getTime())
}

{
  const opensAt = new Date(now.getTime() + 2 * DAY)
  const w = cohortWindow(base({ enrollmentOpensAt: opensAt }))
  check('before the doors open it is announced', w.phase === 'announced')
  check('and cannot be bought', !w.canEnroll)
  check('the waitlist is shown instead', w.showWaitlist)
  check('the countdown runs to the opening', w.countdownTo?.getTime() === opensAt.getTime())
  check('and says so', w.countdownLabel === 'until the doors open')
}

{
  // One second after the doors open.
  const opensAt = new Date(now.getTime() - 1000)
  const w = cohortWindow(base({ enrollmentOpensAt: opensAt }))
  check('a second after opening it is open', w.phase === 'open' && w.canEnroll)
}

{
  const closesAt = new Date(now.getTime() + 5 * DAY)
  const w = cohortWindow(base({ enrollmentClosesAt: closesAt }))
  check('an explicit close is what the countdown runs to', w.countdownTo?.getTime() === closesAt.getTime())
  check('and it is open until then', w.canEnroll)
}

{
  const closesAt = new Date(now.getTime() - 1000)
  const w = cohortWindow(base({ enrollmentClosesAt: closesAt }))
  check('a second after closing it is closed', w.phase === 'closed')
  check('and cannot be bought', !w.canEnroll)
  check('the waitlist is shown', w.showWaitlist)
  check('counting down to the start instead', w.countdownTo?.getTime() === base().startsAt.getTime())
}

{
  // A close date AFTER the start is nonsense: joining on day three is not
  // joining. The start wins.
  const startsAt = new Date(now.getTime() + 3 * DAY)
  const closes = doorsCloseAt({
    startsAt,
    enrollmentClosesAt: new Date(now.getTime() + 9 * DAY),
  })
  check('a close date after the start is clamped to the start', closes.getTime() === startsAt.getTime())
}

console.log('\nclosing soon')

{
  const w = cohortWindow(base({ enrollmentClosesAt: new Date(now.getTime() + 47 * HOUR) }))
  check('inside the window it is closing soon', w.phase === 'closing_soon')
  check('and is still buyable', w.canEnroll)
  check('the urgency line is honest', urgencyLine(w) === 'Closing soon.')
}

{
  const w = cohortWindow(base({ enrollmentClosesAt: new Date(now.getTime() + 49 * HOUR) }))
  check('outside the window it is simply open', w.phase === 'open')
}

{
  const w = cohortWindow(
    base({ enrollmentClosesAt: new Date(now.getTime() + 3 * HOUR), closingSoonHours: 2 }),
  )
  check('the threshold can be moved', w.phase === 'open')
}

console.log('\nseats')

check('no capacity means no seat count', cohortWindow(base()).seatsLeft === null)
check(
  'no capacity never invents urgency',
  urgencyLine(cohortWindow(base())) === null,
)
check('seats left is capacity minus taken', cohortWindow(base({ capacity: 20, seatsTaken: 7 })).seatsLeft === 13)
check(
  'an oversold cohort never shows a negative',
  cohortWindow(base({ capacity: 10, seatsTaken: 14 })).seatsLeft === 0,
)

{
  const w = cohortWindow(base({ capacity: 10, seatsTaken: 10 }))
  check('a full room is full', w.phase === 'full')
  check('and cannot be bought', !w.canEnroll)
  check('the waitlist is shown', w.showWaitlist)
  check('and it says so plainly', urgencyLine(w) === 'Every seat is taken.')
}

{
  const w = cohortWindow(base({ capacity: 10, seatsTaken: 9 }))
  check('one seat left reads as one seat', urgencyLine(w) === 'One seat left.')
}

{
  const w = cohortWindow(base({ capacity: 10, seatsTaken: 8 }))
  check('two seats left reads as two', urgencyLine(w) === '2 seats left.')
}

{
  // Full beats closing soon: there is nothing to hurry for.
  const w = cohortWindow(
    base({ capacity: 5, seatsTaken: 5, enrollmentClosesAt: new Date(now.getTime() + HOUR) }),
  )
  check('a full room is full rather than closing soon', w.phase === 'full')
}

console.log('\nunder way, and over')

{
  const w = cohortWindow(base({ startsAt: new Date(now.getTime() - 1000) }))
  check('a second after the start it is running', w.phase === 'running')
  check('it is still public', w.isPublic)
  check('but it cannot be joined', !w.canEnroll)
  check('and it is on day one', w.currentDay === 1)
}

{
  const w = cohortWindow(base({ startsAt: new Date(now.getTime() - 2 * DAY) }))
  check('two days in it is on day three', w.currentDay === 3, String(w.currentDay))
}

{
  // Never past the last day, however long ago it started.
  const w = cohortWindow(base({
    startsAt: new Date(now.getTime() - 5 * DAY),
    endsAt: new Date(now.getTime() + DAY),
    durationDays: 3,
  }))
  check('the day never runs past the duration', w.currentDay === 3, String(w.currentDay))
}

{
  const w = cohortWindow(base({ startsAt: new Date(now.getTime() - 30 * DAY) }))
  check('long afterwards it is finished', w.phase === 'finished')
  check('finished has no countdown', w.countdownTo === null)
  check('and no day', w.currentDay === null)
}

{
  const startsAt = new Date(now.getTime() - 30 * DAY)
  const derived = endsAtOrDerived({ startsAt, endsAt: null, durationDays: 7 })
  check('with no end date the duration decides', derived.getTime() === startsAt.getTime() + 7 * DAY)

  const explicit = new Date(now.getTime() + DAY)
  check(
    'an explicit end wins',
    endsAtOrDerived({ startsAt, endsAt: explicit, durationDays: 7 }).getTime() === explicit.getTime(),
  )
}

console.log('\nsessions')

{
  const session = { startsAt: new Date(now.getTime() + 30 * 60_000), durationMinutes: 60 }
  check('a session is not live an hour early', !sessionIsLive(session, new Date(now.getTime() - 40 * 60_000)))
  check('it opens ten minutes before', sessionIsLive(session, new Date(now.getTime() + 21 * 60_000)))
  check('it is live during', sessionIsLive(session, new Date(now.getTime() + 45 * 60_000)))
  check('it closes when it ends', !sessionIsLive(session, new Date(now.getTime() + 91 * 60_000)))
}

{
  const sessions = [
    { id: 'c', startsAt: new Date(now.getTime() + 3 * DAY), durationMinutes: 60 },
    { id: 'a', startsAt: new Date(now.getTime() - 3 * DAY), durationMinutes: 60 },
    { id: 'b', startsAt: new Date(now.getTime() + DAY), durationMinutes: 60 },
  ]
  check('the next session is the soonest still to come', nextSession(sessions, now)?.id === 'b')
  check('a finished session is never next', nextSession([sessions[1]!], now) === null)
  check(
    'a session happening right now is still next',
    nextSession([{ id: 'x', startsAt: new Date(now.getTime() - 10 * 60_000), durationMinutes: 60 }], now)?.id === 'x',
  )
}

console.log('\nwhose clock decides the day')

check(
  'a cohort uses the cohort clock',
  pacingTimeZone('cohort', 'Pacific/Auckland', 'America/Los_Angeles') === 'America/Los_Angeles',
)
check(
  'a date-based programme does too',
  pacingTimeZone('date_based', 'Pacific/Auckland', 'America/Los_Angeles') === 'America/Los_Angeles',
)
check(
  'a solo drip uses HER clock',
  pacingTimeZone('drip', 'Pacific/Auckland', 'America/Los_Angeles') === 'Pacific/Auckland',
)
check(
  'a drip programme with a cohort attached still uses hers',
  pacingTimeZone('drip', 'Pacific/Auckland', 'Europe/London') === 'Pacific/Auckland',
)
check(
  'a cohort with no timezone falls back to hers',
  pacingTimeZone('cohort', 'Pacific/Auckland', null) === 'Pacific/Auckland',
)

/*
 * Why that matters, concretely.
 *
 * Two women in the same cohort, twenty-one hours apart. Before this, each was
 * paced on her own clock — so the woman in Auckland opened Day 3 while the
 * host was running the Day 2 call. They now agree, because they are both
 * reading the cohort's clock.
 */
check(
  'two women in different timezones read the same clock',
  pacingTimeZone('cohort', 'Pacific/Auckland', 'America/Los_Angeles') ===
    pacingTimeZone('cohort', 'America/New_York', 'America/Los_Angeles'),
)

console.log('\nregression: reminders for a cohort')

const stamp = Date.now()

async function main() {
  /*
   * The bug this covers.
   *
   * `sendDayReminders` never passed `cohortStartsAt` to the unlock
   * calculation. Under cohort pacing that means the calculation saw no start
   * date, concluded nothing had opened, and skipped her — so NOBODY in a
   * cohort would ever have received a single day reminder. Silent, total, and
   * only visible on the day of a launch.
   */
  const slug = `cohort-check-${stamp}`
  const email = `cohort-check-${stamp}@example.test`

  const [program] = await db
    .insert(programs)
    .values({
      slug,
      title: 'Cohort check',
      kind: 'challenge',
      status: 'published',
      pacing: 'cohort',
      durationDays: 7,
    })
    .returning()

  const [version] = await db
    .insert(programVersions)
    .values({ programId: program!.id, version: 1, publishedAt: new Date() })
    .returning()

  for (let i = 1; i <= 7; i++) {
    const [module] = await db
      .insert(modules)
      .values({ versionId: version!.id, position: i, title: `Day ${i}` })
      .returning()
    await db
      .insert(lessons)
      .values({ moduleId: module!.id, position: 1, title: `Day ${i}` })
  }

  const startedTwoDaysAgo = new Date(Date.now() - 2 * DAY)

  const [cohort] = await db
    .insert(cohorts)
    .values({
      programId: program!.id,
      versionId: version!.id,
      name: 'Check cohort',
      slug,
      status: 'scheduled',
      startsAt: startedTwoDaysAgo,
      timezone: 'UTC',
    })
    .returning()

  const [contact] = await db
    .insert(contacts)
    .values({ email, firstName: 'Ada', timezone: 'UTC' })
    .returning()

  await db.insert(enrollments).values({
    contactId: contact!.id,
    programId: program!.id,
    versionId: version!.id,
    cohortId: cohort!.id,
    timezoneAtStart: 'UTC',
    status: 'active',
    startedAt: startedTwoDaysAgo,
  })

  // Her reminder hour, so the job considers her at all.
  const atHerHour = new Date()
  atHerHour.setUTCMinutes(0, 0, 0)
  await db.insert(profiles).values({
    userId: crypto.randomUUID(),
    contactId: contact!.id,
    notificationPrefs: { reminderHour: atHerHour.getUTCHours() },
  })

  const summary = await sendDayReminders(db, 'https://example.test', atHerHour)
  check(
    'a woman in a running cohort is sent her day',
    summary.sent >= 1,
    JSON.stringify(summary),
  )

  console.log('\ncleaning up')
  await db.delete(contacts).where(eq(contacts.id, contact!.id))
  await db.delete(programs).where(eq(programs.id, program!.id))
  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(eq(contacts.email, email))
  check('the test left nothing behind', (left?.n ?? 0) === 0)

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

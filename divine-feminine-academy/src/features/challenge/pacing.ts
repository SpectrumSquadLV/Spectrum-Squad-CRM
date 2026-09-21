/**
 * Drip pacing.
 *
 * A challenge day unlocks on a CALENDAR DAY boundary in the timezone she
 * started in, not 24 hours after she signed up. A woman who starts at 11pm on
 * Monday gets Day 2 on Tuesday morning, not Tuesday night - anything else and
 * the "daily" practice drifts later every day until she drops out.
 *
 * Pure functions with no database and no clock of their own, so the rules can
 * be tested directly.
 */

export type Pacing = 'immediate' | 'drip' | 'cohort' | 'date_based'

/**
 * Midnights elapsed between two instants, counted in `timeZone`.
 *
 * Uses Intl to read the civil date in her timezone, which handles daylight
 * saving without a timezone library: the civil date is what actually decides
 * whether a new day has begun for her.
 */
export function calendarDaysBetween(
  from: Date,
  to: Date,
  timeZone: string,
): number {
  const civil = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d)

    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? '0')

    // Date.UTC on the civil date gives a stable midnight-to-midnight count.
    return Date.UTC(get('year'), get('month') - 1, get('day'))
  }

  return Math.round((civil(to) - civil(from)) / 86_400_000)
}

export interface UnlockInput {
  pacing: Pacing
  startedAt: Date
  now: Date
  timeZone: string
  durationDays: number
  /** Whether a woman may open the next day before it drips. */
  allowEarlyUnlock: boolean
  /**
   * QA only: open every day at once, for this ONE person.
   *
   * Set from the actor, never from the programme, and only ever true for
   * staff. It bypasses the 24-hour release timing and NOTHING else - every
   * other production behaviour is identical, because a test that skips the
   * database writes, the callbacks, the mirror timers or the Day 7 logic is a
   * test of something nobody will ever use.
   *
   * It is a per-request flag rather than a row on her enrollment precisely so
   * it cannot leak: there is nothing to accidentally set on a real client.
   */
  unlockAllForQa?: boolean
  /** Highest day she has actually finished. 0 before she starts. */
  highestCompletedDay: number
  /** For cohort and date_based programs. */
  cohortStartsAt?: Date | null
}

export interface UnlockState {
  /** The furthest day she is allowed to open. */
  unlockedThrough: number
  /** Where the app should send her. */
  currentDay: number
  /** True when every day is finished. */
  isComplete: boolean
  /** Null when nothing is waiting. */
  nextUnlockDay: number | null
}

/** Validate a timezone once, and fall back rather than throwing at her. */
export function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date())
    return timeZone
  } catch {
    return 'UTC'
  }
}

export function computeUnlockState(input: UnlockInput): UnlockState {
  const {
    pacing,
    startedAt,
    now,
    durationDays,
    allowEarlyUnlock,
    highestCompletedDay,
    cohortStartsAt,
    unlockAllForQa = false,
  } = input

  const timeZone = safeTimeZone(input.timeZone)
  const clamp = (n: number) => Math.max(0, Math.min(durationDays, n))

  let unlockedThrough: number

  if (pacing === 'immediate' || allowEarlyUnlock || unlockAllForQa) {
    // She may move as fast as she likes.
    unlockedThrough = durationDays
  } else if (pacing === 'cohort' || pacing === 'date_based') {
    // Nothing opens before the cohort starts.
    if (!cohortStartsAt || now < cohortStartsAt) {
      unlockedThrough = 0
    } else {
      unlockedThrough = clamp(
        calendarDaysBetween(cohortStartsAt, now, timeZone) + 1,
      )
    }
  } else {
    unlockedThrough = clamp(calendarDaysBetween(startedAt, now, timeZone) + 1)
  }

  const completed = clamp(highestCompletedDay)

  // A day she has already finished never re-locks. Without this, a pacing
  // change, a cohort move or a timezone correction could put a day she has
  // done behind a locked door.
  unlockedThrough = Math.max(unlockedThrough, completed)

  const isComplete = completed >= durationDays

  // Send her to the first day she has not finished, but never past what has
  // unlocked - otherwise a woman who falls behind lands on a locked door.
  const nextUnfinished = Math.min(completed + 1, durationDays)
  const currentDay = isComplete
    ? durationDays
    : Math.max(1, Math.min(nextUnfinished, Math.max(unlockedThrough, 1)))

  const nextUnlockDay =
    !isComplete && unlockedThrough < durationDays ? unlockedThrough + 1 : null

  return { unlockedThrough, currentDay, isComplete, nextUnlockDay }
}

/** Whether a specific day may be opened right now. */
export function isDayUnlocked(day: number, state: UnlockState): boolean {
  return day >= 1 && day <= Math.max(state.unlockedThrough, 0)
}

/**
 * When the next day opens, as an instant: the next midnight in her timezone.
 * Used for "come back tomorrow" copy and to schedule her reminder.
 */
export function nextUnlockAt(now: Date, timeZone: string): Date {
  const tz = safeTimeZone(timeZone)
  // Walk forward in hours until the civil date in her zone changes. Cheap, and
  // correct across daylight saving without a timezone library.
  for (let hours = 1; hours <= 48; hours++) {
    const candidate = new Date(now.getTime() + hours * 3_600_000)
    if (calendarDaysBetween(now, candidate, tz) >= 1) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour: '2-digit',
        hour12: false,
      }).formatToParts(candidate)
      const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
      return new Date(candidate.getTime() - hour * 3_600_000)
    }
  }
  return new Date(now.getTime() + 86_400_000)
}

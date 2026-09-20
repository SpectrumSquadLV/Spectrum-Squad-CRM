/**
 * Where a cohort is in its own life.
 *
 * One pure function decides everything the rest of the system does about a
 * cohort: whether the page is public, whether the button says Join or Tell me
 * when, what the countdown counts to, and whether a payment may be taken.
 *
 * It has to be ONE function because the alternative is what usually happens:
 * the page decides the doors are open, the checkout decides they are shut, and
 * a woman is charged for something she cannot get into — or worse, sees a
 * timer counting down to a moment that has already passed.
 *
 * No database, no clock of its own, no React. Every awkward boundary here is a
 * test rather than a hope.
 */

import { calendarDaysBetween, safeTimeZone } from '@/features/challenge/pacing'

export type CohortStatus = 'draft' | 'scheduled' | 'cancelled'

export interface CohortWindowInput {
  status: CohortStatus
  startsAt: Date
  endsAt: Date | null
  timezone: string
  enrollmentOpensAt: Date | null
  enrollmentClosesAt: Date | null
  capacity: number | null
  seatsTaken: number
  durationDays: number
  now: Date
  /** How long before the doors shut counts as "closing". */
  closingSoonHours?: number
}

export type CohortPhase =
  /** Not public at all. */
  | 'draft'
  | 'cancelled'
  /** Public, but the doors have not opened. Waitlist. */
  | 'announced'
  /** Doors open. */
  | 'open'
  /** Doors open, and shutting shortly. */
  | 'closing_soon'
  /** Doors open by date, but every seat is taken. Waitlist. */
  | 'full'
  /** Doors shut, not started yet. Waitlist for the next one. */
  | 'closed'
  /** Under way. */
  | 'running'
  | 'finished'

export interface CohortWindow {
  phase: CohortPhase
  /** Whether the public page exists at all. */
  isPublic: boolean
  /** Whether a payment may be taken RIGHT NOW. The only authority on this. */
  canEnroll: boolean
  /** Whether the waitlist form should be shown instead. */
  showWaitlist: boolean
  /** What a countdown on the page should count to, if anything. */
  countdownTo: Date | null
  /** What that countdown means, in words. */
  countdownLabel: string | null
  /** Null when uncapped. Never negative. */
  seatsLeft: number | null
  /** Which day the cohort is on, 1-based. Null unless running. */
  currentDay: number | null
}

/**
 * When the doors actually shut.
 *
 * An explicit close wins. Otherwise they shut when the thing starts, because a
 * cohort somebody joins on day three is not a cohort.
 */
export function doorsCloseAt(input: {
  startsAt: Date
  enrollmentClosesAt: Date | null
}): Date {
  const explicit = input.enrollmentClosesAt
  if (!explicit) return input.startsAt
  // A close date after the start is treated as the start: joining after
  // everybody else has begun is not something to sell.
  return explicit < input.startsAt ? explicit : input.startsAt
}

/** When it is over. An explicit end wins; otherwise the duration decides. */
export function endsAtOrDerived(input: {
  startsAt: Date
  endsAt: Date | null
  durationDays: number
}): Date {
  if (input.endsAt) return input.endsAt
  const days = Math.max(1, input.durationDays)
  return new Date(input.startsAt.getTime() + days * 86_400_000)
}

export function cohortWindow(input: CohortWindowInput): CohortWindow {
  const { now, status } = input
  const closingSoonHours = input.closingSoonHours ?? 48

  const seatsLeft =
    input.capacity === null
      ? null
      : Math.max(0, input.capacity - Math.max(0, input.seatsTaken))

  const base: CohortWindow = {
    phase: 'draft',
    isPublic: false,
    canEnroll: false,
    showWaitlist: false,
    countdownTo: null,
    countdownLabel: null,
    seatsLeft,
    currentDay: null,
  }

  if (status === 'draft') return base
  if (status === 'cancelled') return { ...base, phase: 'cancelled' }

  const ends = endsAtOrDerived(input)

  if (now >= ends) {
    return { ...base, phase: 'finished', isPublic: true }
  }

  if (now >= input.startsAt) {
    const tz = safeTimeZone(input.timezone)
    const day = Math.min(
      Math.max(1, input.durationDays),
      calendarDaysBetween(input.startsAt, now, tz) + 1,
    )
    return {
      ...base,
      phase: 'running',
      isPublic: true,
      // Doors are shut once it is under way: a cohort somebody joins on day
      // three is not a cohort, and the live sessions have already happened.
      showWaitlist: true,
      currentDay: day,
    }
  }

  const closes = doorsCloseAt(input)

  // Announced, doors not yet open.
  if (input.enrollmentOpensAt && now < input.enrollmentOpensAt) {
    return {
      ...base,
      phase: 'announced',
      isPublic: true,
      showWaitlist: true,
      countdownTo: input.enrollmentOpensAt,
      countdownLabel: 'until the doors open',
    }
  }

  // Doors have shut, but it has not started.
  if (now >= closes) {
    return {
      ...base,
      phase: 'closed',
      isPublic: true,
      showWaitlist: true,
      countdownTo: input.startsAt,
      countdownLabel: 'until it begins',
    }
  }

  // Open by date — but a full room is full.
  if (seatsLeft !== null && seatsLeft <= 0) {
    return {
      ...base,
      phase: 'full',
      isPublic: true,
      showWaitlist: true,
      countdownTo: input.startsAt,
      countdownLabel: 'until it begins',
    }
  }

  const hoursLeft = (closes.getTime() - now.getTime()) / 3_600_000

  return {
    ...base,
    phase: hoursLeft <= closingSoonHours ? 'closing_soon' : 'open',
    isPublic: true,
    canEnroll: true,
    countdownTo: closes,
    countdownLabel: 'until the doors close',
  }
}

/**
 * The line under the countdown.
 *
 * Deliberately plain. "Only 3 seats left!!" on a cohort with no capacity set
 * is the kind of invented urgency that works once and costs trust for good, so
 * there is nothing here that is not read from a real column.
 */
export function urgencyLine(window: CohortWindow): string | null {
  if (window.phase === 'closing_soon') return 'Closing soon.'
  if (window.phase === 'full') return 'Every seat is taken.'
  if (window.seatsLeft !== null && window.seatsLeft > 0 && window.canEnroll) {
    return window.seatsLeft === 1
      ? 'One seat left.'
      : `${window.seatsLeft} seats left.`
  }
  return null
}

/** A session is joinable from ten minutes before until it ends. */
export function sessionIsLive(
  session: { startsAt: Date; durationMinutes: number },
  now: Date,
  earlyMinutes = 10,
): boolean {
  const opens = session.startsAt.getTime() - earlyMinutes * 60_000
  const closes = session.startsAt.getTime() + session.durationMinutes * 60_000
  const t = now.getTime()
  return t >= opens && t <= closes
}

/** The next session that has not finished. */
export function nextSession<T extends { startsAt: Date; durationMinutes: number }>(
  sessions: T[],
  now: Date,
): T | null {
  const upcoming = sessions
    .filter((s) => s.startsAt.getTime() + s.durationMinutes * 60_000 > now.getTime())
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  return upcoming[0] ?? null
}

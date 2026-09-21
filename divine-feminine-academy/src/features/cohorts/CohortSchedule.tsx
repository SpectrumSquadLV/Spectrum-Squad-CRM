import type { CohortSessionRow } from '@/db/queries/cohorts'

/**
 * The live calls, in the cohort's timezone.
 *
 * Shown in the COHORT's zone with the zone named, not converted to the
 * reader's. A woman deciding whether she can make a live call needs to know
 * what everyone else is being told, and a silently converted time she then
 * repeats to her partner is how people miss things.
 */
export function CohortSchedule({
  sessions,
  timezone,
}: {
  sessions: CohortSessionRow[]
  timezone: string
}) {
  if (sessions.length === 0) return null

  const format = (date: Date) => {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
        timeZone: timezone,
      }).format(date)
    } catch {
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
        timeZone: 'UTC',
      }).format(date)
    }
  }

  return (
    <section className="mt-14">
      <h2 className="font-display text-2xl">When we meet</h2>
      <ol className="mt-8 divide-y divide-rule border-y border-rule">
        {sessions.map((session) => (
          <li key={session.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-4">
            <span className="min-w-[3.5rem] text-2xs uppercase tracking-[0.15em] text-clay-deep">
              {session.dayNumber ? `Day ${session.dayNumber}` : 'Live'}
            </span>
            <span className="flex-1 font-display text-lg">{session.title}</span>
            <span className="text-sm text-ink-muted">{format(session.startsAt)}</span>
            <span className="text-2xs text-ink-faint">{session.durationMinutes} min</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-2xs text-ink-faint">
        Times are shown in the group&rsquo;s timezone. Every call is recorded.
      </p>
    </section>
  )
}

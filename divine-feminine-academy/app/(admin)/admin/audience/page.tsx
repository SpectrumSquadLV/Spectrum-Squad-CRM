import Link from 'next/link'
import { db } from '@/db/client'
import {
  audienceTotals,
  countsBySource,
  countsByTag,
  optInEvents,
  recentOptIns,
} from '@/db/queries/audience'
import { describeSource, GROUP_LABELS, groupOf, type SourceGroup } from '@/features/admin/sources'

export const metadata = { title: 'Audience' }
export const dynamic = 'force-dynamic'

const EVENT_LABELS: Record<string, string> = {
  'quiz.completed': 'Finished the quiz',
  'archetype.assigned': 'Put into an archetype sequence',
  'writing.subscribed': 'Subscribed from a piece of writing',
  'cohort.waitlisted': 'Joined a cohort waitlist',
  'assessment.completed': 'Finished the assessment',
  'email.unsubscribed': 'Unsubscribed',
}

const dateFormat = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d)

function Stat({
  label,
  value,
  note,
}: {
  label: string
  value: number
  note?: string
}) {
  return (
    <div className="rounded-lg border border-rule bg-alabaster p-4">
      <p className="text-2xs uppercase tracking-[0.15em] text-ink-muted">{label}</p>
      <p className="mt-2 font-display text-3xl tabular-nums">{value}</p>
      {note && <p className="mt-1 text-2xs text-ink-faint">{note}</p>}
    </div>
  )
}

/**
 * Where everybody came from.
 *
 * The question this page exists to answer is the one an owner asks every week:
 * "which of my things is actually bringing people in?" — the quiz, a piece of
 * writing, the challenge, the course.
 *
 * It shows email addresses, because it is her own list on a staff-only page
 * and hiding them would make it useless. It shows nothing anybody WROTE: no
 * journal, no quiz answers, no assessment responses. Where she came from and
 * when, and not one word of what she said.
 */
export default async function AudiencePage() {
  const [totals, sources, tagCounts, events, recent] = await Promise.all([
    audienceTotals(db),
    countsBySource(db),
    countsByTag(db),
    optInEvents(db),
    recentOptIns(db, 40),
  ])

  const byGroup = new Map<SourceGroup, number>()
  for (const s of sources) {
    const g = groupOf(s.source)
    byGroup.set(g, (byGroup.get(g) ?? 0) + s.total)
  }
  const grouped = [...byGroup.entries()].sort((a, b) => b[1] - a[1])
  const biggest = grouped[0]?.[1] ?? 0

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 md:px-8">
      <h1 className="text-lg font-semibold">Audience</h1>
      <p className="mt-2 max-w-xl text-2xs text-ink-muted">
        Everybody who has given you an email address, and which of your things
        brought them in. Nothing anybody wrote appears on this page.
      </p>

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="You can email"
          value={totals.reachable}
          note="not unsubscribed, not bounced"
        />
        <Stat label="Everybody" value={totals.everybody} note="including those who left" />
        <Stat label="Last 7 days" value={totals.addedLast7Days} />
        <Stat label="Last 30 days" value={totals.addedLast30Days} />
      </div>

      {(totals.unsubscribed > 0 || totals.bounced > 0) && (
        <p className="mt-4 text-2xs text-ink-muted">
          {totals.unsubscribed} unsubscribed · {totals.bounced} bounced or
          marked you as spam. Neither is written to again.
        </p>
      )}

      <section className="mt-14">
        <h2 className="text-sm font-semibold">Where they came from</h2>
        {grouped.length === 0 ? (
          <p className="mt-3 text-2xs text-ink-muted">Nobody yet.</p>
        ) : (
          <ul className="mt-5 space-y-3">
            {grouped.map(([group, total]) => (
              <li key={group}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm">{GROUP_LABELS[group]}</span>
                  <span className="font-display text-lg tabular-nums">{total}</span>
                </div>
                <div className="mt-1.5 h-1 rounded-full bg-linen">
                  <div
                    className="h-1 rounded-full bg-clay"
                    style={{ width: `${biggest > 0 ? (total / biggest) * 100 : 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-14">
        <h2 className="text-sm font-semibold">Broken down</h2>
        <p className="mt-2 text-2xs text-ink-muted">
          The exact door each woman came through. This is the first one only —
          where she found you, not everything she has done since.
        </p>
        {sources.length === 0 ? (
          <p className="mt-3 text-2xs text-ink-muted">Nothing yet.</p>
        ) : (
          <table className="mt-5 w-full text-left text-2xs">
            <thead className="border-b border-rule text-ink-muted">
              <tr>
                <th className="py-2 font-normal">Door</th>
                <th className="py-2 text-right font-normal">All time</th>
                <th className="py-2 text-right font-normal">30 days</th>
                <th className="py-2 text-right font-normal">Left</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {sources.map((s) => {
                const described = describeSource(s.source)
                return (
                  <tr key={s.source ?? 'none'}>
                    <td className="py-3 pr-4">
                      <span className="text-sm text-ink">{described.label}</span>
                      {described.detail && (
                        <span className="mt-0.5 block text-2xs text-ink-faint">
                          {described.detail}
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-right tabular-nums">{s.total}</td>
                    <td className="py-3 text-right tabular-nums">{s.last30Days}</td>
                    <td className="py-3 text-right tabular-nums text-ink-faint">
                      {s.unsubscribed || '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-14">
        <h2 className="text-sm font-semibold">Every time somebody opted in</h2>
        <p className="mt-2 text-2xs text-ink-muted">
          Counted differently from the table above: this is every moment
          somebody chose to hear from you, including after she was already on
          the list. One woman can appear more than once, and that is correct.
        </p>
        {events.length === 0 ? (
          <p className="mt-3 text-2xs text-ink-muted">Nothing yet.</p>
        ) : (
          <ul className="mt-5 divide-y divide-rule border-y border-rule">
            {events.map((e) => (
              <li key={e.eventType} className="flex items-baseline justify-between gap-4 py-3">
                <span className="text-sm">{EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                <span className="text-2xs text-ink-muted">
                  <span className="font-display text-base tabular-nums text-ink">{e.total}</span>
                  {' · '}
                  {e.last30Days} in 30 days
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {tagCounts.length > 0 && (
        <section className="mt-14">
          <h2 className="text-sm font-semibold">Tags</h2>
          <ul className="mt-5 flex flex-wrap gap-2">
            {tagCounts.map((t) => (
              <li
                key={t.slug}
                className="rounded-full border border-rule px-3 py-1 text-2xs"
              >
                {t.name}{' '}
                <span className="tabular-nums text-ink-muted">{t.total}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-14">
        <h2 className="text-sm font-semibold">Who just arrived</h2>
        {recent.length === 0 ? (
          <p className="mt-3 text-2xs text-ink-muted">Nobody yet.</p>
        ) : (
          <ul className="mt-5 divide-y divide-rule border-y border-rule">
            {recent.map((r) => {
              const described = describeSource(r.source)
              return (
                <li key={r.contactId} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
                  <Link
                    href={`/admin/contacts/${r.contactId}`}
                    className="text-sm hover:underline"
                  >
                    {r.firstName?.trim() || 'No name given'}
                  </Link>
                  <span className="text-2xs text-ink-muted">{r.email}</span>
                  <span className="ml-auto text-2xs text-clay-deep">{described.label}</span>
                  <span className="w-28 text-right text-2xs text-ink-faint">
                    {dateFormat(r.joinedAt)}
                  </span>
                  {r.unsubscribed && (
                    <span className="w-full text-2xs text-critical">Unsubscribed</span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

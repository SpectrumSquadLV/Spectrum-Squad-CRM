import { Rule } from '@/design-system/primitives'
import {
  getDayDropOff,
  getFunnel,
  getHeadlines,
  getSources,
  listActiveProgramSlugs,
} from '@/db/queries/analytics'
import { getQueryContext } from '@/lib/auth/actor-server'

export const metadata = { title: 'Analytics' }

/**
 * The funnel.
 *
 * Every number here is a query over `activity_events` or the tables it points
 * at — which is why writing an event row for every meaningful action from the
 * very first phase was worth it.
 *
 * Journal content appears nowhere. It cannot: the queries behind this page
 * have no way to read it.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ program?: string | string[] }>
}) {
  const params = await searchParams
  const requested = Array.isArray(params.program) ? params.program[0] : params.program

  const ctx = await getQueryContext()
  const [headlines, funnel, sources, availablePrograms] = await Promise.all([
    getHeadlines(ctx),
    getFunnel(ctx),
    getSources(ctx),
    listActiveProgramSlugs(ctx),
  ])

  const programSlug = requested ?? availablePrograms[0]?.slug ?? 'me-vs-her'
  const dropOff = await getDayDropOff(ctx, programSlug)

  const widest = Math.max(1, ...funnel.map((s) => s.count))

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <h1 className="text-lg font-semibold">Analytics</h1>

      <dl className="mt-8 grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-3">
        {headlines.map((h) => (
          <div key={h.label} className="bg-alabaster p-5">
            <dd className="font-display text-2xl leading-none">{h.value}</dd>
            <dt className="mt-2 text-2xs text-ink-muted">
              {h.label}
              {h.note && <span className="block text-ink-faint">{h.note}</span>}
            </dt>
          </div>
        ))}
      </dl>

      <Rule className="my-10" />

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
          The funnel
        </h2>
        <ul className="mt-6 space-y-4">
          {funnel.map((step) => (
            <li key={step.label}>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-xs">{step.label}</span>
                <span className="flex items-baseline gap-3">
                  {step.conversionFromPrevious !== null && (
                    <span className="text-2xs text-ink-faint">
                      {step.conversionFromPrevious}%
                    </span>
                  )}
                  <span className="font-display text-xl">{step.count}</span>
                </span>
              </div>
              <div className="mt-1.5 h-1 rounded-full bg-linen">
                <div
                  className="h-1 rounded-full bg-clay"
                  style={{ width: `${Math.round((step.count / widest) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <Rule className="my-10" />

      <section>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
            Where women stall
          </h2>
          {availablePrograms.length > 1 && (
            <form>
              <select
                name="program"
                defaultValue={programSlug}
                className="min-h-10 rounded-md border border-rule-strong bg-alabaster px-2 text-2xs"
              >
                {availablePrograms.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.title}
                  </option>
                ))}
              </select>
              <button type="submit" className="ml-2 text-2xs text-clay-deep underline">
                show
              </button>
            </form>
          )}
        </div>

        <p className="mt-2 max-w-xl text-2xs text-ink-muted">
          The most useful number here. If half of them stop on Day 2, Day 2 is
          the problem, and no amount of traffic fixes it.
        </p>

        {dropOff.length === 0 ? (
          <p className="mt-6 text-2xs text-ink-muted">Nothing to measure yet.</p>
        ) : (
          <table className="mt-6 w-full border-collapse text-2xs">
            <thead>
              <tr className="border-b border-rule-strong text-left text-ink-muted">
                <th className="py-2 pr-4 font-medium">Day</th>
                <th className="py-2 pr-4 font-medium">Finished it</th>
                <th className="py-2 font-medium">Stopped here</th>
              </tr>
            </thead>
            <tbody>
              {dropOff.map((day) => (
                <tr key={day.day} className="border-b border-rule">
                  <td className="py-3 pr-4">
                    <span className="text-xs text-ink">
                      {day.day}. {day.title}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-ink-muted">{day.completed}</td>
                  <td className="py-3">
                    <span
                      className={
                        day.lostHere > 0 ? 'text-caution' : 'text-ink-faint'
                      }
                    >
                      {day.lostHere > 0 ? `−${day.lostHere}` : '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Rule className="my-10" />

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
          Where they come from
        </h2>
        {sources.length === 0 ? (
          <p className="mt-4 text-2xs text-ink-muted">No contacts yet.</p>
        ) : (
          <table className="mt-5 w-full border-collapse text-2xs">
            <thead>
              <tr className="border-b border-rule-strong text-left text-ink-muted">
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 font-medium">Contacts</th>
                <th className="py-2 pr-4 font-medium">Paid</th>
                <th className="py-2 font-medium">Conversion</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.source} className="border-b border-rule">
                  <td className="py-3 pr-4 text-xs">{s.source}</td>
                  <td className="py-3 pr-4 text-ink-muted">{s.count}</td>
                  <td className="py-3 pr-4 text-ink-muted">{s.paid}</td>
                  <td className="py-3 text-ink-muted">{s.conversion}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="mt-10 text-2xs text-ink-muted">
        Journal content appears nowhere on this page, and cannot — the queries
        behind it have no way to read it.
      </p>
    </div>
  )
}

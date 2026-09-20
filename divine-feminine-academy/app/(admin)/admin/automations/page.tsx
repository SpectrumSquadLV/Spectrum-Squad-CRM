import { desc, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { automationRules, automationRuns, emailEvents } from '@/db/schema'
import { Badge, Rule } from '@/design-system/primitives'

export const metadata = { title: 'Automations' }

export default async function AutomationsPage() {
  const [rules, recentRuns, emailCounts] = await Promise.all([
    db
      .select({
        rule: automationRules,
        runs: sql<number>`(
          SELECT count(*) FROM ${automationRuns}
          WHERE ${automationRuns.ruleId} = ${automationRules.id}
        )`,
        failures: sql<number>`(
          SELECT count(*) FROM ${automationRuns}
          WHERE ${automationRuns.ruleId} = ${automationRules.id}
            AND ${automationRuns.status} = 'failed'
        )`,
      })
      .from(automationRules)
      .orderBy(desc(automationRules.createdAt)),
    db
      .select({ run: automationRuns, ruleName: automationRules.name })
      .from(automationRuns)
      .innerJoin(automationRules, eq(automationRules.id, automationRuns.ruleId))
      .orderBy(desc(automationRuns.createdAt))
      .limit(25),
    db
      .select({ type: emailEvents.type, count: sql<number>`count(*)` })
      .from(emailEvents)
      .groupBy(emailEvents.type),
  ])

  const configured = Boolean(process.env.CRON_SECRET)
  const emailConfigured = Boolean(process.env.RESEND_API_KEY)

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <h1 className="text-lg font-semibold">Automations</h1>

      <div className="mt-6 flex flex-col gap-3">
        {!configured && (
          <p className="rounded-md border border-caution/40 bg-caution/5 px-4 py-3 text-2xs text-caution">
            <strong>CRON_SECRET is not set</strong>, so <code>/api/cron/automations</code>{' '}
            refuses every request and nothing scheduled will run. That is
            deliberate — an open endpoint could trigger every email in the
            system.
          </p>
        )}
        {!emailConfigured && (
          <p className="rounded-md border border-caution/40 bg-caution/5 px-4 py-3 text-2xs text-caution">
            <strong>RESEND_API_KEY is not set.</strong> Emails are being
            discarded, including sign-in links.
          </p>
        )}
      </div>

      <p className="mt-6 max-w-2xl text-2xs text-ink-muted">
        Day reminders, stall nudges and abandoned-checkout emails are jobs, not
        rules — they are driven by the passage of time rather than an event, and
        run from the same hourly endpoint. Everything here is idempotent, so
        running it twice in an hour sends nothing twice.
      </p>

      <Rule className="my-8" />

      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
        Rules
      </h2>

      {rules.length === 0 ? (
        <p className="mt-4 text-2xs text-ink-muted">
          None yet. The built-in jobs run regardless.
        </p>
      ) : (
        <table className="mt-5 w-full border-collapse text-2xs">
          <thead>
            <tr className="border-b border-rule-strong text-left text-ink-muted">
              <th className="py-2 pr-4 font-medium">Rule</th>
              <th className="py-2 pr-4 font-medium">On</th>
              <th className="py-2 pr-4 font-medium">Delay</th>
              <th className="py-2 pr-4 font-medium">Does</th>
              <th className="py-2 pr-4 font-medium">Runs</th>
              <th className="py-2 font-medium">Active</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(({ rule, runs, failures }) => (
              <tr key={rule.id} className="border-b border-rule">
                <td className="py-3 pr-4 text-xs text-ink">{rule.name}</td>
                <td className="py-3 pr-4 font-mono text-ink-muted">
                  {rule.triggerEvent}
                </td>
                <td className="py-3 pr-4 text-ink-muted">
                  {rule.delayMinutes === 0 ? 'now' : `${rule.delayMinutes}m`}
                </td>
                <td className="py-3 pr-4 text-ink-muted">{rule.action}</td>
                <td className="py-3 pr-4 text-ink-muted">
                  {Number(runs)}
                  {Number(failures) > 0 && (
                    <span className="text-critical"> · {Number(failures)} failed</span>
                  )}
                </td>
                <td className="py-3">
                  <Badge
                    className={
                      rule.isActive ? 'border-positive/40 text-positive' : undefined
                    }
                  >
                    {rule.isActive ? 'on' : 'off'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Rule className="my-10" />

      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
        Email
      </h2>
      <dl className="mt-5 flex flex-wrap gap-6">
        {emailCounts.length === 0 ? (
          <span className="text-2xs text-ink-muted">Nothing sent yet.</span>
        ) : (
          emailCounts.map((e) => (
            <div key={e.type}>
              <dd className="font-display text-xl leading-none">
                {Number(e.count)}
              </dd>
              <dt className="mt-1 text-2xs text-ink-muted">{e.type}</dt>
            </div>
          ))
        )}
      </dl>

      {recentRuns.length > 0 && (
        <>
          <Rule className="my-10" />
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
            Recent runs
          </h2>
          <table className="mt-5 w-full border-collapse text-2xs">
            <thead>
              <tr className="border-b border-rule-strong text-left text-ink-muted">
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Rule</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map(({ run, ruleName }) => (
                <tr key={run.id} className="border-b border-rule">
                  <td className="py-3 pr-4 text-ink-muted">
                    {run.createdAt.toLocaleDateString('en-US')}
                  </td>
                  <td className="py-3 pr-4">{ruleName}</td>
                  <td className="py-3 pr-4">
                    <Badge
                      className={
                        run.status === 'failed'
                          ? 'border-critical/40 text-critical'
                          : run.status === 'succeeded'
                            ? 'border-positive/40 text-positive'
                            : undefined
                      }
                    >
                      {run.status}
                    </Badge>
                  </td>
                  <td className="py-3 text-ink-faint">{run.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

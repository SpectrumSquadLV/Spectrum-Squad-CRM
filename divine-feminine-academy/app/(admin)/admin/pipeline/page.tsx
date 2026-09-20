import Link from 'next/link'
import { Badge, Rule } from '@/design-system/primitives'
import { listOpenFollowUps, pipelineCounts, searchContacts } from '@/db/queries/crm'
import { getQueryContext } from '@/lib/auth/actor-server'

export const metadata = { title: 'Pipeline' }

/**
 * The Monday-morning pipeline.
 *
 * Columns are `crm_stages` rows, so you can rename or reorder them without a
 * developer. Stage moves are recorded in `contact_stage_history`, which is how
 * you learn where women stall.
 */
export default async function PipelinePage() {
  const ctx = await getQueryContext()
  const [stages, followUps] = await Promise.all([
    pipelineCounts(ctx),
    listOpenFollowUps(ctx),
  ])

  const columns = await Promise.all(
    stages.map(async (stage) => ({
      stage,
      contacts: await searchContacts(ctx, { stageId: stage.id, limit: 8 }),
    })),
  )

  const now = Date.now()

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <h1 className="text-lg font-semibold">Pipeline</h1>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {columns.map(({ stage, contacts }) => (
          <section key={stage.id} className="border border-rule bg-alabaster p-3">
            <header className="flex items-baseline justify-between gap-2">
              <h2 className="text-2xs font-semibold uppercase tracking-[0.12em]">
                {stage.name}
              </h2>
              <span className="font-display text-lg leading-none">{stage.count}</span>
            </header>

            <ul className="mt-3 space-y-2">
              {contacts.map(({ contact }) => (
                <li key={contact.id}>
                  <Link
                    href={`/admin/contacts/${contact.id}`}
                    className="block rounded-sm border border-rule bg-bone px-2 py-1.5 hover:border-clay"
                  >
                    <span className="block text-2xs text-ink">
                      {[contact.firstName, contact.lastName]
                        .filter(Boolean)
                        .join(' ') || contact.email}
                    </span>
                  </Link>
                </li>
              ))}
              {contacts.length === 0 && (
                <li className="py-2 text-2xs text-ink-faint">Empty</li>
              )}
            </ul>

            {stage.count > contacts.length && (
              <Link
                href={`/admin/contacts?stage=${stage.id}`}
                className="mt-3 inline-flex min-h-9 items-center text-2xs text-clay-deep underline underline-offset-4"
              >
                See all {stage.count}
              </Link>
            )}
          </section>
        ))}
      </div>

      <Rule className="my-10" />

      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
        Follow-ups
      </h2>

      {followUps.length === 0 ? (
        <p className="mt-4 text-2xs text-ink-muted">Nothing outstanding.</p>
      ) : (
        <ul className="mt-5 divide-y divide-rule border-y border-rule">
          {followUps.map(({ followUp, contact }) => {
            const overdue = followUp.dueAt.getTime() < now
            return (
              <li key={followUp.id} className="flex flex-wrap items-center gap-3 py-3">
                <Link
                  href={`/admin/contacts/${contact.id}`}
                  className="text-xs hover:text-clay-deep"
                >
                  {[contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
                    contact.email}
                </Link>
                {overdue && (
                  <Badge className="border-critical/40 text-critical">overdue</Badge>
                )}
                <span className="text-2xs text-ink-muted">
                  {followUp.dueAt.toLocaleDateString('en-US')}
                </span>
                {followUp.note && (
                  <span className="text-2xs text-ink-faint">{followUp.note}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

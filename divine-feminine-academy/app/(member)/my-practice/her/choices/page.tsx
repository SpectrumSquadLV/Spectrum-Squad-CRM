import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Badge, Card, CardBody, CardTitle, Rule } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import { Eyebrow } from '@/design-system/patterns'
import { choiceSummary, listChoices } from '@/db/queries/her'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

export const metadata: Metadata = { title: 'I chose HER' }

const isArea = (v: string | null): v is Area =>
  v === 'self' || v === 'love' || v === 'life' || v === 'wealth'

export default async function ChoicesPage() {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) redirect('/login')

  const ctx = await getQueryContext()
  const [choices, summary] = await Promise.all([
    listChoices(ctx, actor.contactId),
    choiceSummary(ctx, actor.contactId),
  ])

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 md:px-8 md:py-16">
      <Eyebrow>I chose HER</Eyebrow>
      <h1 className="mt-4 font-display text-5xl leading-none">{summary.total}</h1>
      <p className="mt-3 text-sm text-ink-muted">
        time{summary.total === 1 ? '' : 's'}, so far
      </p>

      {summary.byArea.length > 0 && (
        <div className="mt-8 flex flex-wrap gap-3">
          {summary.byArea
            .filter((a) => isArea(a.area))
            .map((a) => (
              <span key={a.area} className="flex items-center gap-2">
                {isArea(a.area) && <Badge area={a.area}>{a.area}</Badge>}
                <span className="text-xs text-ink-muted">{a.count}</span>
              </span>
            ))}
        </div>
      )}

      <Rule tone="gilt" className="my-12" />

      {choices.length === 0 ? (
        <Card tone="sunken">
          <CardTitle className="text-lg">Nothing logged yet</CardTitle>
          <CardBody className="text-xs">
            Day 6 is where this starts. After that it is yours to add to, any
            time, from anywhere.
          </CardBody>
        </Card>
      ) : (
        <ul className="divide-y divide-rule border-y border-rule">
          {choices.map((c) => (
            <li key={c.id} className="py-6">
              <div className="flex items-baseline justify-between gap-4">
                {isArea(c.area) ? <Badge area={c.area}>{c.area}</Badge> : <span />}
                <time
                  dateTime={c.occurredAt.toISOString()}
                  className="text-2xs text-ink-faint"
                >
                  {c.occurredAt.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </time>
              </div>
              {c.situation && (
                <p className="mt-3 text-sm text-ink-soft">{c.situation}</p>
              )}
              <p className="mt-2 text-sm text-plum">{c.herResponse}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

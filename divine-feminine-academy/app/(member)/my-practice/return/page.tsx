import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Rule } from '@/design-system/primitives'
import { Eyebrow, Prose } from '@/design-system/patterns'
import { listReturnSessions } from '@/db/queries/her'
import { ReturnFlow } from '@/features/challenge/ReturnFlow'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

export const metadata: Metadata = { title: 'Return' }

/**
 * The RETURN practice, standalone.
 *
 * She reaches this on a bad day, from one tap, at low capacity. Large targets,
 * few words, nothing cheerful. No enrollment is required: coming back to
 * herself is never gated on a programme.
 */
export default async function ReturnPage() {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) redirect('/login')

  const ctx = await getQueryContext()
  const sessions = await listReturnSessions(ctx, actor.contactId, 10)

  return (
    <div className="mx-auto max-w-2xl px-5 py-12 md:px-8 md:py-16">
      <Eyebrow>Return</Eyebrow>
      <h1 className="mt-4 text-3xl">Come back to yourself.</h1>
      <Prose className="mt-4 text-sm">
        <p>Six questions, then one thing that helps. Take as long as you need.</p>
      </Prose>

      <ReturnFlow className="mt-12" sessions={sessions} />

      {sessions.length > 0 && (
        <>
          <Rule tone="gilt" className="my-14" />
          <h2 className="text-xl">Times you came back</h2>
          <ul className="mt-6 divide-y divide-rule border-y border-rule">
            {sessions.map((s) => (
              <li key={s.id} className="py-4">
                <div className="flex items-baseline justify-between gap-4">
                  <p className="text-sm text-ink-soft">{s.feeling ?? '—'}</p>
                  <time
                    dateTime={s.occurredAt.toISOString()}
                    className="text-2xs text-ink-faint"
                  >
                    {s.occurredAt.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </time>
                </div>
                {s.actionChosen && (
                  <p className="mt-1 text-2xs text-ink-muted">
                    {s.customAction ?? s.actionChosen}
                    {s.actionCompletedAt ? ' · done' : ''}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

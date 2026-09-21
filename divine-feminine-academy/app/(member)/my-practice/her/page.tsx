import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Badge, Button, Card, CardBody, CardTitle, Rule } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import { Eyebrow, Prose } from '@/design-system/patterns'
import { choiceSummary, listPatterns } from '@/db/queries/her'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

export const metadata: Metadata = { title: 'HER' }

const isArea = (v: string | null): v is Area =>
  v === 'herself' || v === 'relationships' || v === 'success' || v === 'money'

/**
 * Her HER profile.
 *
 * This page is the thing a course platform cannot do: it remembers who she is
 * becoming. Built on Day 1, added to by every programme after.
 */
export default async function HerPage() {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) redirect('/login')

  const ctx = await getQueryContext()
  const [patterns, choices] = await Promise.all([
    listPatterns(ctx, actor.contactId),
    choiceSummary(ctx, actor.contactId),
  ])

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 md:px-8 md:py-16">
      <Eyebrow>HER</Eyebrow>
      <h1 className="mt-4 text-3xl">Who you are becoming</h1>

      {patterns.length === 0 ? (
        <Card tone="sunken" className="mt-10">
          <CardTitle className="text-lg">Nothing named yet</CardTitle>
          <CardBody className="text-xs">
            Day 1 is where this begins. What you write there stays here, and
            every programme after reads from it.
          </CardBody>
        </Card>
      ) : (
        <>
          <Prose className="mt-6">
            <p>
              {patterns.length} pattern{patterns.length === 1 ? '' : 's'} named.
              You have chosen her {choices.total} time
              {choices.total === 1 ? '' : 's'}.
            </p>
          </Prose>

          <ul className="mt-12 space-y-10">
            {patterns.map((p) => (
              <li key={p.id}>
                {isArea(p.area) && <Badge area={p.area}>{p.area}</Badge>}
                <p className="mt-2 font-display text-xl">{p.triggerText}</p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="border-l border-rule-strong pl-4">
                    <p className="text-2xs uppercase tracking-[0.16em] text-ink-muted">
                      Current Me
                    </p>
                    <p className="mt-1 text-sm text-ink-soft">
                      {p.currentResponse ?? '—'}
                    </p>
                  </div>
                  <div className="border-l border-plum/40 pl-4">
                    <p className="text-2xs uppercase tracking-[0.16em] text-plum">
                      HER
                    </p>
                    <p className="mt-1 text-sm text-plum">{p.herResponse ?? '—'}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <Rule tone="gilt" className="my-14" />

      <div className="flex flex-wrap gap-4">
        <Button variant="secondary" asChild>
          <Link href="/my-practice/her/choices">Every time you chose her</Link>
        </Button>
        <Button variant="secondary" asChild>
          <Link href="/my-practice/her/code">Your HER Code</Link>
        </Button>
      </div>
    </div>
  )
}

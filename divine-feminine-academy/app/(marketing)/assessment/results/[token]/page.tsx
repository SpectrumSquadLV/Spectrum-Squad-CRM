import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { Badge, Button, Rule } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'
import { getAttemptByToken, getPriorAttempt } from '@/db/queries/assessments'
import { areaLabels } from '@/features/assessment/scoring'

export const metadata: Metadata = {
  title: 'Your result',
  robots: { index: false, follow: false },
}

const isArea = (v: string): v is Area =>
  v === 'herself' || v === 'relationships' || v === 'success' || v === 'money'

/* Labels come from the scoring module so no surface can drift from it. */
const labels = areaLabels

/**
 * Her result, opened from a link in her inbox.
 *
 * Deliberately no login: asking a woman to make an account before she can see
 * something true about herself is where the funnel dies. The token is the
 * credential, and the page is not indexed.
 */
export default async function ResultsPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const found = await getAttemptByToken(db, token)
  if (!found) notFound()

  const { attempt, result, contact } = found
  if (!result) notFound()

  const prior =
    attempt.timing === 'post'
      ? await getPriorAttempt(db, attempt.contactId, attempt.versionId, attempt.id)
      : null

  const scores = (result.categoryScores ?? {}) as Record<string, number | null>
  const priorScores = (prior?.result.categoryScores ?? {}) as Record<
    string,
    number | null
  >

  const rows = Object.entries(scores)
    .filter(([area, score]) => isArea(area) && score !== null)
    .map(([area, score]) => {
      const before = priorScores[area]
      return {
        area: area as Area,
        score: score as number,
        delta:
          typeof before === 'number' ? (score as number) - before : null,
      }
    })
    .sort((a, b) => a.score - b.score)

  const loudest = rows[0]

  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Your result</Eyebrow>
      <h1 className="mt-6 text-3xl">
        {contact?.firstName ? `${contact.firstName},` : 'Here it is.'}
        {contact?.firstName && ' here it is.'}
      </h1>

      {loudest && (
        <Prose className="mt-6 text-lg">
          <p>
            Right now it is loudest in <strong>{labels[loudest.area]}</strong>.
            That is not a verdict — it is where the work is.
          </p>
        </Prose>
      )}

      <ul className="mt-12 space-y-7">
        {rows.map((row) => (
          <li key={row.area}>
            <div className="flex items-baseline justify-between gap-4">
              <Badge area={row.area}>{labels[row.area]}</Badge>
              <span className="flex items-baseline gap-3">
                {row.delta !== null && (
                  <span
                    className={
                      row.delta >= 0 ? 'text-2xs text-positive' : 'text-2xs text-caution'
                    }
                  >
                    {row.delta >= 0 ? '+' : ''}
                    {row.delta}
                  </span>
                )}
                <span className="font-display text-2xl">{row.score}</span>
              </span>
            </div>
            <div className="mt-2 h-1 rounded-full bg-linen">
              <div
                className="h-1 rounded-full bg-clay"
                style={{ width: `${row.score}%` }}
              />
            </div>
          </li>
        ))}
      </ul>

      {prior && (
        <p className="mt-8 text-xs text-ink-muted">
          Compared with the last time you took this.
        </p>
      )}

      <Rule tone="gilt" className="my-14" />

      <h2 className="text-2xl">What to do with that</h2>
      <Prose className="mt-4">
        <p>
          Seven days, about twenty minutes each. You name the pattern, practise
          choosing differently, and learn the way back when you lose her.
        </p>
      </Prose>
      <Button size="lg" className="mt-8" asChild>
        <Link href="/me-vs-her">Start ME VS HER</Link>
      </Button>

      <p className="mt-10 text-2xs text-ink-muted">
        Keep this link — it is how you get back to this page.
      </p>
    </Section>
  )
}

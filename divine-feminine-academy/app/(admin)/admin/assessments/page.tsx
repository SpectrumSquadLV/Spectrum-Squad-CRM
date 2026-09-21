import { desc, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  assessmentAttempts,
  assessmentResults,
  assessmentVersions,
  assessments,
} from '@/db/schema'
import { Badge, Rule } from '@/design-system/primitives'

export const metadata = { title: 'Assessments' }

export default async function AdminAssessmentsPage() {
  const rows = await db
    .select({
      assessment: assessments,
      versions: sql<number>`(
        SELECT count(*) FROM ${assessmentVersions}
        WHERE ${assessmentVersions.assessmentId} = ${assessments.id}
      )`,
      attempts: sql<number>`(
        SELECT count(*) FROM ${assessmentAttempts}
        JOIN ${assessmentVersions} v ON v.id = ${assessmentAttempts.versionId}
        WHERE v.assessment_id = ${assessments.id}
      )`,
    })
    .from(assessments)
    .orderBy(assessments.title)

  const recent = await db
    .select({
      attempt: assessmentAttempts,
      result: assessmentResults,
    })
    .from(assessmentAttempts)
    .leftJoin(
      assessmentResults,
      eq(assessmentResults.attemptId, assessmentAttempts.id),
    )
    .orderBy(desc(assessmentAttempts.startedAt))
    .limit(25)

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <h1 className="text-lg font-semibold">Assessments</h1>
      <p className="mt-2 max-w-xl text-2xs text-ink-muted">
        Scoring normalises every area to 0–100 and excludes open questions.
        Reverse-scored items are inverted, so agreeing with everything does not
        produce a flattering picture.
      </p>

      {rows.length === 0 ? (
        <p className="mt-8 text-2xs text-ink-muted">
          Nothing seeded yet. Run <code>npm run seed:assessment</code>.
        </p>
      ) : (
        <table className="mt-8 w-full border-collapse text-2xs">
          <thead>
            <tr className="border-b border-rule-strong text-left text-ink-muted">
              <th className="py-2 pr-4 font-medium">Assessment</th>
              <th className="py-2 pr-4 font-medium">Versions</th>
              <th className="py-2 font-medium">Attempts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.assessment.id} className="border-b border-rule">
                <td className="py-3 pr-4">
                  <span className="text-xs text-ink">{r.assessment.title}</span>
                  <span className="block text-ink-faint">/{r.assessment.slug}</span>
                </td>
                <td className="py-3 pr-4 text-ink-muted">{Number(r.versions)}</td>
                <td className="py-3 text-ink-muted">{Number(r.attempts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Rule className="my-10" />

      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
        Recent attempts
      </h2>

      {recent.length === 0 ? (
        <p className="mt-4 text-2xs text-ink-muted">None yet.</p>
      ) : (
        <table className="mt-5 w-full border-collapse text-2xs">
          <thead>
            <tr className="border-b border-rule-strong text-left text-ink-muted">
              <th className="py-2 pr-4 font-medium">When</th>
              <th className="py-2 pr-4 font-medium">Timing</th>
              <th className="py-2 pr-4 font-medium">Overall</th>
              <th className="py-2 font-medium">By area</th>
            </tr>
          </thead>
          <tbody>
            {recent.map(({ attempt, result }) => {
              const scores = (result?.categoryScores ?? {}) as Record<
                string,
                number | null
              >
              return (
                <tr key={attempt.id} className="border-b border-rule">
                  <td className="py-3 pr-4 text-ink-muted">
                    {attempt.startedAt.toLocaleDateString('en-US')}
                  </td>
                  <td className="py-3 pr-4">
                    <Badge>{attempt.timing}</Badge>
                  </td>
                  <td className="py-3 pr-4 text-ink">
                    {result?.overallScore ?? '—'}
                  </td>
                  <td className="py-3 text-ink-muted">
                    {Object.entries(scores)
                      .filter(([, v]) => v !== null)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

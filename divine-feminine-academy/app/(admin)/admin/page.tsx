import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  certificates,
  contacts,
  enrollments,
  herChoices,
  programs,
} from '@/db/schema'
import { Card, CardBody, CardTitle } from '@/design-system/primitives'

/**
 * The Monday-morning view.
 *
 * Deliberately small: the numbers that say whether the business is working,
 * and nothing else. The full CRM is Phase 5.
 */
export default async function AdminOverviewPage() {
  const [counts] = await db
    .select({
      contacts: sql<number>`(SELECT count(*) FROM ${contacts})`,
      enrolled: sql<number>`(SELECT count(*) FROM ${enrollments})`,
      completed: sql<number>`(SELECT count(*) FROM ${enrollments} WHERE ${enrollments.status} = 'completed')`,
      programs: sql<number>`(SELECT count(*) FROM ${programs} WHERE ${programs.status} = 'published')`,
      choices: sql<number>`(SELECT count(*) FROM ${herChoices})`,
      certificates: sql<number>`(SELECT count(*) FROM ${certificates})`,
    })
    .from(sql`(SELECT 1) AS one`)

  const stats = [
    { label: 'Contacts', value: Number(counts?.contacts ?? 0) },
    { label: 'Enrollments', value: Number(counts?.enrolled ?? 0) },
    { label: 'Completed', value: Number(counts?.completed ?? 0) },
    { label: 'Published programs', value: Number(counts?.programs ?? 0) },
    { label: 'HER choices logged', value: Number(counts?.choices ?? 0) },
    { label: 'Certificates issued', value: Number(counts?.certificates ?? 0) },
  ]

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <h1 className="text-lg font-semibold">Overview</h1>

      <dl className="mt-8 grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label} className="bg-alabaster p-5">
            <dd className="font-display text-3xl leading-none">{s.value}</dd>
            <dt className="mt-2 text-2xs text-ink-muted">{s.label}</dt>
          </div>
        ))}
      </dl>

      <div className="mt-10 grid gap-5 md:grid-cols-3">
        <Card tone="flat">
          <CardTitle className="text-base">Programs</CardTitle>
          <CardBody className="text-2xs">
            Build a programme from blocks. No developer required.
          </CardBody>
          <Link
            href="/admin/programs"
            className="mt-4 inline-flex min-h-9 items-center text-2xs text-clay-deep underline underline-offset-4"
          >
            Open
          </Link>
        </Card>
        <Card tone="flat">
          <CardTitle className="text-base">Assessments</CardTitle>
          <CardBody className="text-2xs">
            Questions, scoring by area, and pre/post comparison.
          </CardBody>
          <Link
            href="/admin/assessments"
            className="mt-4 inline-flex min-h-9 items-center text-2xs text-clay-deep underline underline-offset-4"
          >
            Open
          </Link>
        </Card>
        <Card tone="flat">
          <CardTitle className="text-base">Certificates</CardTitle>
          <CardBody className="text-2xs">
            What a woman has to do to earn one, and who has.
          </CardBody>
          <Link
            href="/admin/certificates"
            className="mt-4 inline-flex min-h-9 items-center text-2xs text-clay-deep underline underline-offset-4"
          >
            Open
          </Link>
        </Card>
      </div>

      <p className="mt-10 text-2xs text-ink-muted">
        Journal content is never shown here. Admin surfaces read engagement
        metadata only — entry counts, dates and word counts — and cannot decrypt
        what she wrote.
      </p>
    </div>
  )
}

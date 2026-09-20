import Link from 'next/link'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { certificates, contacts, programs } from '@/db/schema'
import { Badge, Rule } from '@/design-system/primitives'
import { listPrograms } from '@/db/queries/admin-programs'
import { loadRequirements } from '@/features/certificates/issue'
import { getQueryContext } from '@/lib/auth/actor-server'

export const metadata = { title: 'Certificates' }

const ruleLabels: Record<string, string> = {
  lessons_completed_pct: 'Days finished',
  required_blocks_answered: 'Required exercises answered',
  post_assessment_submitted: 'Closing assessment submitted',
  her_choices_logged: 'HER choices logged',
  her_code_finalized: 'HER Code written',
}

export default async function AdminCertificatesPage() {
  const ctx = await getQueryContext()
  const allPrograms = await listPrograms(ctx)

  const withRules = await Promise.all(
    allPrograms.map(async (p) => ({
      program: p,
      requirements: await loadRequirements(db, p.id),
    })),
  )

  const issued = await db
    .select({
      certificate: certificates,
      programTitle: programs.title,
      email: contacts.email,
    })
    .from(certificates)
    .innerJoin(programs, eq(programs.id, certificates.programId))
    .innerJoin(contacts, eq(contacts.id, certificates.contactId))
    .orderBy(desc(certificates.issuedAt))
    .limit(50)

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <h1 className="text-lg font-semibold">Certificates</h1>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
          What each programme requires
        </h2>
        <p className="mt-2 max-w-xl text-2xs text-ink-muted">
          A programme with no requirements configured awards nothing — silence
          does not mean yes. Requirements are evaluated when she finishes the
          last day.
        </p>

        <div className="mt-6 flex flex-col gap-4">
          {withRules.map(({ program, requirements }) => (
            <div key={program.id} className="border border-rule bg-alabaster p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href={`/admin/programs/${program.id}`}
                  className="text-xs font-medium hover:text-clay-deep"
                >
                  {program.title}
                </Link>
                {requirements.length === 0 && (
                  <Badge className="border-caution/40 text-caution">
                    no certificate
                  </Badge>
                )}
              </div>

              {requirements.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-2xs text-ink-muted">
                  {requirements.map((r) => (
                    <li key={r.requirementType}>
                      {ruleLabels[r.requirementType] ?? r.requirementType}
                      {r.requirementType === 'lessons_completed_pct' &&
                        ` ≥ ${r.threshold}%`}
                      {r.requirementType === 'her_choices_logged' &&
                        ` ≥ ${r.threshold}`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      <Rule className="my-10" />

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
          Issued
        </h2>

        {issued.length === 0 ? (
          <p className="mt-4 text-2xs text-ink-muted">None yet.</p>
        ) : (
          <table className="mt-5 w-full border-collapse text-2xs">
            <thead>
              <tr className="border-b border-rule-strong text-left text-ink-muted">
                <th className="py-2 pr-4 font-medium">Number</th>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Program</th>
                <th className="py-2 pr-4 font-medium">Issued</th>
                <th className="py-2 font-medium">Verify</th>
              </tr>
            </thead>
            <tbody>
              {issued.map(({ certificate, programTitle }) => (
                <tr key={certificate.id} className="border-b border-rule">
                  <td className="py-3 pr-4 font-mono">
                    {certificate.certificateNumber}
                  </td>
                  <td className="py-3 pr-4">{certificate.recipientName}</td>
                  <td className="py-3 pr-4 text-ink-muted">{programTitle}</td>
                  <td className="py-3 pr-4 text-ink-muted">
                    {certificate.issuedAt.toLocaleDateString('en-US')}
                  </td>
                  <td className="py-3">
                    <Link
                      href={`/verify/${certificate.verificationToken}`}
                      className="text-clay-deep underline underline-offset-4"
                    >
                      open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

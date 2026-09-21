import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { certificates, programs } from '@/db/schema'
import { Button, Card, CardBody, CardTitle, Rule } from '@/design-system/primitives'
import { Eyebrow, Prose } from '@/design-system/patterns'
import { getActor } from '@/lib/auth/actor-server'
import { siteUrl } from '@/lib/auth/env'

export const metadata: Metadata = { title: 'Certificates' }

export default async function CertificatesPage() {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) redirect('/login')

  const rows = await db
    .select({ certificate: certificates, programTitle: programs.title })
    .from(certificates)
    .innerJoin(programs, eq(programs.id, certificates.programId))
    .where(eq(certificates.contactId, actor.contactId))
    .orderBy(desc(certificates.issuedAt))

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 md:px-8 md:py-16">
      <Eyebrow>Certificates</Eyebrow>
      <h1 className="mt-4 text-3xl">What you finished</h1>

      {rows.length === 0 ? (
        <Card tone="sunken" className="mt-10">
          <CardTitle className="text-lg">Nothing yet</CardTitle>
          <CardBody className="text-xs">
            Finish a programme and your certificate appears here, with a link
            anyone can check.
          </CardBody>
        </Card>
      ) : (
        <ul className="mt-10 space-y-6">
          {rows.map(({ certificate, programTitle }) => (
            <li
              key={certificate.id}
              className="rounded-lg border border-rule bg-alabaster p-6"
            >
              <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
                {certificate.issuedAt.toLocaleDateString('en-US', {
                  month: 'long',
                  year: 'numeric',
                })}
              </p>
              <h2 className="mt-2 font-display text-xl">{programTitle}</h2>
              <p className="mt-1 font-mono text-2xs text-ink-faint">
                {certificate.certificateNumber}
              </p>

              {certificate.revokedAt ? (
                <p className="mt-4 text-xs text-critical">This has been revoked.</p>
              ) : (
                <>
                  <Rule tone="gilt" className="my-5" />
                  <Button size="sm" variant="secondary" asChild>
                    <Link href={`/verify/${certificate.verificationToken}`}>
                      Open the verification page
                    </Link>
                  </Button>
                  <p className="mt-3 break-all text-2xs text-ink-faint">
                    {siteUrl()}/verify/{certificate.verificationToken}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <Prose className="mt-10 text-sm">
        <p>
          Anyone with that link can confirm the certificate is genuine. It shows
          your name, the programme and the date — nothing else about you.
        </p>
      </Prose>
    </div>
  )
}

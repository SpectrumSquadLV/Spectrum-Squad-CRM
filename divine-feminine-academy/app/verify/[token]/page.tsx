import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { certificates, programs } from '@/db/schema'
import { Button, Rule } from '@/design-system/primitives'

export const metadata: Metadata = {
  title: 'Verify a certificate',
  description: 'Check that a Divine Feminine Academy certificate is genuine.',
}

/**
 * Public certificate verification.
 *
 * This page is what makes a certificate mean anything: anybody holding one can
 * be checked by anybody. It deliberately shows only what is printed on the
 * certificate itself — a name, a programme, a date — and nothing else about
 * her.
 */
export default async function VerifyPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const [row] = await db
    .select({
      certificate: certificates,
      programTitle: programs.title,
    })
    .from(certificates)
    .innerJoin(programs, eq(programs.id, certificates.programId))
    .where(eq(certificates.verificationToken, token))
    .limit(1)

  if (!row) notFound()

  const { certificate, programTitle } = row
  const revoked = Boolean(certificate.revokedAt)

  return (
    <main className="mx-auto min-h-screen max-w-xl px-5 py-16 md:py-24">
      <div className="rounded-xl border border-rule bg-alabaster p-8 md:p-12">
        <p className="text-2xs uppercase tracking-[0.3em] text-clay-deep">
          Divine Feminine Academy
        </p>

        {revoked ? (
          <>
            <h1 className="mt-6 font-display text-2xl text-critical">
              This certificate has been revoked.
            </h1>
            <p className="mt-4 text-sm text-ink-soft">
              It was issued, and has since been withdrawn.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-6 font-display text-2xl">This certificate is genuine.</h1>

            <Rule tone="gilt" className="my-8" />

            <dl className="space-y-5 text-sm">
              <div>
                <dt className="text-2xs uppercase tracking-[0.16em] text-ink-muted">
                  Awarded to
                </dt>
                <dd className="mt-1 font-display text-xl">
                  {certificate.recipientName}
                </dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-[0.16em] text-ink-muted">
                  For completing
                </dt>
                <dd className="mt-1">{programTitle}</dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-[0.16em] text-ink-muted">
                  Issued
                </dt>
                <dd className="mt-1">
                  {certificate.issuedAt.toLocaleDateString('en-US', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-[0.16em] text-ink-muted">
                  Number
                </dt>
                <dd className="mt-1 font-mono text-xs">
                  {certificate.certificateNumber}
                </dd>
              </div>
            </dl>
          </>
        )}
      </div>

      <div className="mt-10 text-center">
        <Button variant="secondary" asChild>
          <Link href="/">Divine Feminine Academy</Link>
        </Button>
      </div>
    </main>
  )
}

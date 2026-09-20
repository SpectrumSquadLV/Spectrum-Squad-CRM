import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Check your email',
  robots: { index: false, follow: false },
}

export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string | string[] }>
}) {
  const params = await searchParams
  const email = Array.isArray(params.email) ? params.email[0] : params.email

  return (
    <div className="text-center">
      <h1 className="text-2xl">Check your email.</h1>
      <p className="mt-4 text-sm text-ink-soft">
        {email ? (
          <>
            A link is on its way to <span className="text-ink">{email}</span>.
          </>
        ) : (
          'A link is on its way.'
        )}
      </p>
      <p className="mt-6 text-2xs text-ink-muted">
        It expires in an hour. If it does not arrive, check your spam folder,
        then{' '}
        <Link href="/login" className="underline underline-offset-2">
          ask for another
        </Link>
        .
      </p>
    </div>
  )
}

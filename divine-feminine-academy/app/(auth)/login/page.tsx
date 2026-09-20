import type { Metadata } from 'next'
import Link from 'next/link'
import { SignInForm } from '@/features/auth/SignInForm'

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
}

const errors: Record<string, string> = {
  'link-expired': 'That link has expired. Here is a fresh one.',
  'missing-code': 'That link was incomplete. Try again.',
  'session-required': 'Sign in to see that page.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v
  const errorKey = one(params.error)
  const message = errorKey ? errors[errorKey] : undefined

  return (
    <div>
      <h1 className="text-2xl">Welcome back.</h1>
      <p className="mt-3 text-xs text-ink-muted">
        Your email, and we will send you a link. No password to remember.
      </p>

      {message && (
        <p
          role="status"
          className="mt-6 rounded-md border border-caution/40 bg-caution/5 px-4 py-3 text-2xs text-caution"
        >
          {message}
        </p>
      )}

      <SignInForm className="mt-8" next={one(params.next)} />

      <p className="mt-8 text-2xs text-ink-muted">
        First time?{' '}
        <Link href="/signup" className="underline underline-offset-2">
          Begin here
        </Link>
      </p>
    </div>
  )
}

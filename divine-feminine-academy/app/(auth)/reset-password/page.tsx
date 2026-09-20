import type { Metadata } from 'next'
import Link from 'next/link'
import { SignInForm } from '@/features/auth/SignInForm'

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
}

/**
 * There are no passwords yet, so there is nothing to reset. Rather than a dead
 * link in the footer of an email, this sends her the magic link she actually
 * needs. If password sign-in is added later, this page becomes the real reset.
 */
export default function ResetPasswordPage() {
  return (
    <div>
      <h1 className="text-2xl">No password needed.</h1>
      <p className="mt-3 text-xs text-ink-muted">
        This account signs in with a link, so there is nothing to reset. Put
        your email in and we will send you one.
      </p>
      <SignInForm className="mt-8" />
      <p className="mt-8 text-2xs text-ink-muted">
        <Link href="/login" className="underline underline-offset-2">
          Back to sign in
        </Link>
      </p>
    </div>
  )
}

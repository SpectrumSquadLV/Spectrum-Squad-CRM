import type { Metadata } from 'next'
import Link from 'next/link'
import { JoinForm } from '@/features/auth/JoinForm'
import { AccountsOff } from '@/features/auth/AccountsOff'

export const metadata: Metadata = {
  title: 'Begin',
  robots: { index: false, follow: false },
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v

  return (
    <div>
      <AccountsOff />

      <h1 className="text-2xl">Begin.</h1>
      <p className="mt-3 text-xs text-ink-muted">
        Your first name and your email. No password — we will send you a link.
      </p>

      <JoinForm
        className="mt-8"
        source={one(params.source)}
        utmSource={one(params.utm_source)}
        utmMedium={one(params.utm_medium)}
        utmCampaign={one(params.utm_campaign)}
        next={one(params.next)}
        submitLabel="Send my link"
      />

      <p className="mt-8 text-2xs text-ink-muted">
        Already here?{' '}
        <Link href="/login" className="underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </div>
  )
}

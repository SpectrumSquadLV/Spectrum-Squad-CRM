import Link from 'next/link'
import { isSupabaseConfigured } from '@/lib/auth/env'

/**
 * Shown on the auth pages when there is nothing to sign in to.
 *
 * Somebody can still reach /login from a bookmark, a stale link or a typed
 * URL even with the header button hidden, and a sign-in form that cannot
 * work is a dead end with no explanation. This says so plainly and sends her
 * somewhere real.
 *
 * Renders nothing once the keys are set, so it disappears by itself the day
 * accounts are switched on. Nobody has to remember to remove it.
 */
export function AccountsOff() {
  if (isSupabaseConfigured()) return null

  return (
    <div className="rounded-lg border border-rule bg-linen/60 p-5">
      <h2 className="font-display text-lg leading-snug">
        Accounts are not open yet.
      </h2>
      <p className="mt-3 text-xs leading-relaxed text-ink-soft">
        There is nothing to sign in to here quite yet — the work is being
        built. Nothing is wrong with your email.
      </p>
      <p className="mt-4 text-xs">
        <Link
          href="/the-divine-feminine"
          className="underline underline-offset-4 hover:text-clay-deep"
        >
          Be told when it opens
        </Link>
      </p>
    </div>
  )
}

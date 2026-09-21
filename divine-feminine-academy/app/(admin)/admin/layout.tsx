import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdminNav } from '@/features/admin/AdminNav'
import { getActor } from '@/lib/auth/actor-server'
import { isStaff } from '@/lib/permissions/actor'

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin' },
  robots: { index: false, follow: false },
}

/** Nothing under /admin may be prerendered; every page reads live data. */
export const dynamic = 'force-dynamic'

/**
 * The Console surface, and the role gate.
 *
 * `proxy.ts` only knows whether somebody is signed in - it cannot check roles
 * without a database round trip on every request. So the real gate is here:
 * staff only, and a 404 rather than a redirect, because confirming that an
 * admin area exists is itself information.
 *
 * The one exception is the design system, which lives at /admin/design and is
 * reachable in development without a login. It renders tokens and nothing
 * else; see proxy.ts.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const actor = await getActor()

  const devStyleGuide =
    process.env.NODE_ENV !== 'production' && actor.kind === 'guest'

  if (!isStaff(actor) && !devStyleGuide) notFound()

  return (
    <div className="surface-console min-h-screen bg-bone">
      <a
        href="#admin-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-plum focus:px-4 focus:py-2 focus:text-bone"
      >
        Skip to content
      </a>
      <AdminNav canManageRoles={actor.kind === 'user' && actor.roles.includes('owner')} />
      <main id="admin-main">{children}</main>
    </div>
  )
}

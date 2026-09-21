import { getActor } from '@/lib/auth/actor-server'
import { isAdmin } from '@/lib/permissions/actor'
import { cn } from '@/lib/utils/cn'

/**
 * A note about unfinished work, visible ONLY to Quiana.
 *
 * The public site is a sales page now, not a build. A stranger who lands on
 * the home page must never see a dashed amber box saying which copy has not
 * been written yet - that is the difference between a business and a project
 * somebody is still working on.
 *
 * But the notes have to live SOMEWHERE, and a list in a file nobody opens is
 * a list nobody reads. So they sit exactly where the missing copy goes, on
 * the real page, in the real layout, and only an admin sees them.
 *
 * Fails closed. getActor returns a guest whenever Supabase is not configured
 * or the cookie does not verify, so the failure mode of every branch here -
 * misconfiguration, an expired session, an outage - is that the note does not
 * render. That is the correct direction to fail in.
 *
 * Because this reads the session, a page using it cannot be statically
 * prerendered. Every page that does is already `force-dynamic` for its
 * photographs.
 */
export async function StaffNote({
  what,
  children,
  className,
}: {
  /** The heading Quiana sees. Say what is needed, not what is missing. */
  what: string
  children?: React.ReactNode
  className?: string
}) {
  const actor = await getActor()
  if (!isAdmin(actor)) return null

  return (
    <div
      data-staff-note
      className={cn(
        'my-6 rounded-md border border-dashed border-caution/60 bg-caution/5 p-5',
        className,
      )}
    >
      <p className="text-2xs font-medium uppercase tracking-[0.16em] text-caution">
        Needs Quiana · {what}
      </p>
      {children ? (
        <div className="mt-3 text-xs text-ink-soft [&>p]:mb-2 [&>p:last-child]:mb-0">
          {children}
        </div>
      ) : null}
    </div>
  )
}

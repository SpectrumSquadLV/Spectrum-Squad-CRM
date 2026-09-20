'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { getActor } from '@/lib/auth/actor-server'
import { isAdmin } from '@/lib/permissions/actor'
import { FeedError } from './feed'
import { syncFeed } from './sync'

export type SyncState = {
  error?: string
  message?: string
}

/**
 * Pull the feed now, instead of waiting for the hour.
 *
 * The cron does this every hour anyway; this button exists because publishing
 * an episode and then watching the site not have it for fifty minutes is the
 * kind of thing that makes somebody stop trusting the site.
 *
 * Admin-gated with the same check every other admin action uses. A sync is a
 * write, and the feed URL is configurable, so an open endpoint would let
 * anybody point this at a feed of their own and insert rows.
 */
export async function syncPodcast(
  _prev: SyncState,
  _formData: FormData,
): Promise<SyncState> {
  const actor = await getActor()
  if (!isAdmin(actor)) return { error: 'Not allowed.' }

  try {
    const result = await syncFeed(db, {})

    revalidatePath('/podcast')
    revalidatePath('/admin/writing')

    const parts = [
      result.added > 0 ? `${result.added} new` : null,
      result.updated > 0 ? `${result.updated} updated` : null,
      result.unchanged > 0 ? `${result.unchanged} unchanged` : null,
      result.skipped > 0 ? `${result.skipped} skipped` : null,
    ].filter(Boolean)

    return {
      message:
        parts.length > 0
          ? `Synced: ${parts.join(', ')}.`
          : 'The feed had no episodes on it.',
    }
  } catch (error) {
    // A FeedError knows what actually went wrong - the host was unreachable,
    // the XML did not parse, the URL returned a 404 - and saying so is the
    // difference between fixing it in a minute and guessing for an hour.
    if (error instanceof FeedError) return { error: error.message }
    console.error('[podcast] manual sync failed', error)
    return { error: 'The sync failed. The server log has the details.' }
  }
}

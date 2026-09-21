import type { Metadata } from 'next'
import Link from 'next/link'
import { db } from '@/db/client'
import { Prose, Section } from '@/design-system/patterns'
import { unsubscribeByToken } from '@/features/email/optout'

export const metadata: Metadata = {
  title: 'Unsubscribed',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

/**
 * One click, and it is done.
 *
 * No confirmation button, no "are you sure", no login. A woman who wants out
 * gets out on the first click — anything else is a dark pattern, it is what
 * turns an unsubscribe into a spam complaint, and a spam complaint costs the
 * sending domain far more than she was ever worth.
 *
 * Doing the write on a GET is a real trade-off: a link scanner or a mail
 * client prefetching the URL can unsubscribe her without her asking. Between
 * that and making her click twice, the accidental unsubscribe is the cheaper
 * mistake — and this page tells her plainly how to undo it.
 *
 * Lifecycle mail only. Her sign-in links and her receipts keep working, which
 * is why this sets a flag rather than deleting anything.
 */
export default async function UnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const done = await unsubscribeByToken(db, token)

  return (
    <Section className="pt-20 md:pt-28 pb-24">
      {done ? (
        <>
          <h1 className="text-3xl md:text-4xl">Done. You are unsubscribed.</h1>
          <Prose className="mt-8 text-lg">
            <p>
              No more sequence emails, starting now. Nothing else needs doing.
            </p>
            <p>
              You will still get anything you specifically ask for — a sign-in
              link, a receipt — because unsubscribing from letters should not
              lock you out of your own account.
            </p>
            <p className="text-sm text-ink-muted">
              Clicked this by accident? Email us and we will put you back.
              Nothing has been deleted.
            </p>
          </Prose>
        </>
      ) : (
        <>
          <h1 className="text-3xl md:text-4xl">That link has expired.</h1>
          <Prose className="mt-8 text-lg">
            <p>
              We could not match this link to an address. The likeliest reason
              is that it was copied without the whole of it — they are long.
            </p>
            <p>
              Open the link from the bottom of any email we have sent you, or
              reply to one and we will take you off by hand.
            </p>
          </Prose>
        </>
      )}

      <p className="mt-12">
        <Link href="/" className="text-sm underline underline-offset-4">
          Back to the site
        </Link>
      </p>
    </Section>
  )
}

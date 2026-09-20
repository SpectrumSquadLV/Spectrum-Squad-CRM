import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts } from '@/db/schema'
import { Button, Card, CardBody, CardTitle } from '@/design-system/primitives'
import { Eyebrow, Prose } from '@/design-system/patterns'
import { getHerCode } from '@/db/queries/her'
import { HerCodeDocument, parseSections } from '@/features/her/HerCodeDocument'
import { ShareRow } from '@/features/her/ShareRow'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'
import { siteUrl } from '@/lib/auth/env'

export const metadata: Metadata = { title: 'Your HER Code' }

export default async function HerCodePage() {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) redirect('/login')

  const ctx = await getQueryContext()
  const code = await getHerCode(ctx, actor.contactId)

  const [contact] = await db
    .select({ firstName: contacts.firstName })
    .from(contacts)
    .where(eq(contacts.id, actor.contactId))
    .limit(1)

  if (!code) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 md:px-8">
        <Eyebrow>HER Code</Eyebrow>
        <h1 className="mt-4 text-2xl">Not written yet</h1>
        <Card tone="sunken" className="mt-8">
          <CardTitle className="text-lg">Day 7</CardTitle>
          <CardBody className="text-xs">
            You write this on the last day, after you have read your own week
            back. It will be here when you do.
          </CardBody>
        </Card>
        <Button className="mt-8" asChild>
          <Link href="/my-academy">Back to your academy</Link>
        </Button>
      </div>
    )
  }

  const sections = parseSections(code.sections)
  const shareUrl = code.shareToken ? `${siteUrl()}/her/${code.shareToken}` : null

  return (
    <div className="mx-auto max-w-2xl px-5 py-12 md:px-8 md:py-16">
      <Eyebrow>Yours</Eyebrow>
      <h1 className="mt-4 text-3xl">Your HER Code</h1>

      <HerCodeDocument
        className="mt-10"
        sections={sections}
        name={contact?.firstName ?? null}
        dateLabel={(code.finalizedAt ?? code.createdAt).toLocaleDateString('en-US', {
          month: 'long',
          year: 'numeric',
        })}
      />

      {shareUrl && <ShareRow url={shareUrl} className="mt-8" />}

      <Prose className="mt-10 text-sm">
        <p>
          Sharing this shows only what is on the card. Nothing else about you —
          not your journal, not your patterns, not your email — is on that page.
        </p>
      </Prose>
    </div>
  )
}

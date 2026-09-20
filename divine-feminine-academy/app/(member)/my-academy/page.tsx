import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts } from '@/db/schema'
import { Button, Card, CardBody, CardTitle, Rule } from '@/design-system/primitives'
import { Eyebrow, Prose } from '@/design-system/patterns'
import { getActor } from '@/lib/auth/actor-server'

/**
 * The member home. Never called "Dashboard".
 *
 * It surfaces ONE primary action, not a wall of cards. Whatever she is meant
 * to do next is the only thing that looks like a button.
 */
export default async function MyAcademyPage() {
  const actor = await getActor()

  let firstName: string | null = null
  if (actor.kind === 'user' && actor.contactId) {
    const [contact] = await db
      .select({ firstName: contacts.firstName })
      .from(contacts)
      .where(eq(contacts.id, actor.contactId))
      .limit(1)
    firstName = contact?.firstName ?? null
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 md:px-8 md:py-16">
      <Eyebrow>Welcome back</Eyebrow>
      <h1 className="mt-4 text-3xl">{firstName ? `Hello, ${firstName}.` : 'Hello.'}</h1>

      <Prose className="mt-6">
        <p>
          There is nothing waiting for you yet. The seven days are being built —
          when they open, this is where they will start.
        </p>
      </Prose>

      <Button size="lg" className="mt-8" asChild>
        <Link href="/my-academy/account">Set up your account</Link>
      </Button>

      <Rule tone="gilt" className="my-14" />

      {/* Never more than three cards visible at once. */}
      <div className="grid gap-5 md:grid-cols-3">
        <Card tone="flat">
          <CardTitle className="text-lg">HER</CardTitle>
          <CardBody className="text-xs">
            Your patterns and your responses. Built on Day 1, yours for good.
          </CardBody>
        </Card>
        <Card tone="flat">
          <CardTitle className="text-lg">Journal</CardTitle>
          <CardBody className="text-xs">
            Encrypted. Only you can read it — that includes us.
          </CardBody>
        </Card>
        <Card tone="flat">
          <CardTitle className="text-lg">Return</CardTitle>
          <CardBody className="text-xs">
            The practice for the bad days. One tap, from anywhere.
          </CardBody>
        </Card>
      </div>

      <p className="mt-8 text-2xs text-ink-muted">
        All three open in Phase 3, when the challenge engine is built.
      </p>
    </div>
  )
}

import { Card, CardBody, CardTitle } from '@/design-system/primitives'

/**
 * Placeholder member home.
 *
 * Never called "Dashboard". When this is built for real it surfaces ONE
 * primary action, not a wall of cards.
 */
export default function MyAcademyPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-16 md:px-8">
      <h1 className="text-3xl">Welcome back.</h1>
      <p className="measure mt-4 text-ink-soft">
        This is where her day begins. The challenge engine that fills it is
        Phase 3.
      </p>

      <Card className="mt-10">
        <CardTitle>Nothing here yet</CardTitle>
        <CardBody>
          Foundation build only: tokens, primitives, schema, permissions and the
          block registry. No lesson content exists.
        </CardBody>
      </Card>
    </main>
  )
}

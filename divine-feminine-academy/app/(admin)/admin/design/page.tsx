import {
  Badge,
  Button,
  Card,
  CardBody,
  CardTitle,
  Field,
  Input,
  Rule,
  Textarea,
} from '@/design-system/primitives'
import { listBlocks } from '@/blocks/registry'

/**
 * The living style guide.
 *
 * Every token and primitive renders here. Build this before assembling pages,
 * and check it after changing a token - it is the fastest way to catch a
 * change that quietly breaks three screens.
 */

const colorGroups: { title: string; note?: string; swatches: [string, string][] }[] = [
  {
    title: 'Neutrals',
    note: 'Warm neutrals carry the brand. Colour is an accent, never a wash.',
    swatches: [
      ['ink', 'bg-ink'],
      ['ink-soft', 'bg-ink-soft'],
      ['ink-muted', 'bg-ink-muted'],
      ['ink-faint', 'bg-ink-faint'],
      ['bone', 'bg-bone'],
      ['alabaster', 'bg-alabaster'],
      ['linen', 'bg-linen'],
      ['rule', 'bg-rule'],
      ['rule-strong', 'bg-rule-strong'],
    ],
  },
  {
    title: 'Brand accents',
    note: 'gilt is hairlines and small marks only. Never a fill.',
    swatches: [
      ['clay', 'bg-clay'],
      ['clay-deep', 'bg-clay-deep'],
      ['clay-wash', 'bg-clay-wash'],
      ['plum', 'bg-plum'],
      ['plum-deep', 'bg-plum-deep'],
      ['plum-wash', 'bg-plum-wash'],
      ['sage', 'bg-sage'],
      ['sage-wash', 'bg-sage-wash'],
      ['gilt', 'bg-gilt'],
    ],
  },
  {
    title: 'The four areas',
    note: 'Thin rules and small marks. Never a coloured card.',
    swatches: [
      ['area-self', 'bg-area-self'],
      ['area-love', 'bg-area-love'],
      ['area-life', 'bg-area-life'],
      ['area-wealth', 'bg-area-wealth'],
    ],
  },
  {
    title: 'Feedback',
    swatches: [
      ['positive', 'bg-positive'],
      ['caution', 'bg-caution'],
      ['critical', 'bg-critical'],
      ['critical-wash', 'bg-critical-wash'],
    ],
  },
]

const typeScale: [string, string][] = [
  ['5xl / 84', 'text-5xl'],
  ['4xl / 64', 'text-4xl'],
  ['3xl / 48', 'text-3xl'],
  ['2xl / 36', 'text-2xl'],
  ['xl / 28', 'text-xl'],
  ['lg / 21', 'text-lg'],
  ['base / 18', 'text-base'],
  ['sm / 16', 'text-sm'],
  ['xs / 14', 'text-xs'],
  ['2xs / 12', 'text-2xs'],
]

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-16">
      <h2 className="text-lg font-semibold">{title}</h2>
      {note && <p className="mt-1 text-xs text-ink-muted measure">{note}</p>}
      <Rule className="my-5" />
      {children}
    </section>
  )
}

export default function DesignSystemPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12 md:px-8">
      <header className="mb-14">
        <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
          Divine Feminine
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Design system</h1>
        <p className="mt-2 measure-wide text-xs text-ink-muted">
          Every token and primitive in the system renders on this page. Change a
          token, then check here first — it is the fastest way to catch a change
          that quietly breaks three screens.
        </p>
      </header>

      {colorGroups.map((group) => (
        <Section key={group.title} title={group.title} note={group.note}>
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-5 md:grid-cols-6">
            {group.swatches.map(([name, cls]) => (
              <div key={name}>
                <div
                  className={`h-16 w-full rounded-md border border-rule ${cls}`}
                />
                <p className="mt-1.5 text-2xs text-ink-muted">{name}</p>
              </div>
            ))}
          </div>
        </Section>
      ))}

      <Section
        title="Display type — Fraunces"
        note="Tight tracking. Used for headings on the Editorial surface only; the Console uses Inter throughout."
      >
        <div className="space-y-4">
          {typeScale.slice(0, 6).map(([label, cls]) => (
            <div key={label} className="flex items-baseline gap-6">
              <span className="w-24 shrink-0 text-2xs text-ink-faint">{label}</span>
              <span className={`font-display ${cls}`}>She is already here</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Interface type — Inter"
        note="Body copy gets 1.65 line height and a measure capped near 68 characters."
      >
        <div className="space-y-4">
          {typeScale.slice(5).map(([label, cls]) => (
            <div key={label} className="flex items-baseline gap-6">
              <span className="w-24 shrink-0 text-2xs text-ink-faint">{label}</span>
              <span className={cls}>
                The quick brown fox jumps over the lazy dog
              </span>
            </div>
          ))}
        </div>
        <p className="measure mt-8 text-base text-ink-soft">
          This paragraph shows the default body measure. Line length is capped so
          the eye can find the start of the next line without hunting — the
          single biggest readability lever on a long page, and the one most
          often skipped.
        </p>
      </Section>

      <Section title="Buttons" note="Every target clears 44px. She is on a phone, often one-handed.">
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="primary">Begin Day 1</Button>
          <Button variant="secondary">Not today</Button>
          <Button variant="quiet">Skip</Button>
          <Button variant="link">Read the whole thing</Button>
          <Button disabled>Unavailable</Button>
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </div>
      </Section>

      <Section title="Cards" note="Maximum three cards visible at once anywhere in the member portal.">
        <div className="grid gap-5 md:grid-cols-3">
          <Card>
            <CardTitle>Raised</CardTitle>
            <CardBody>The default. A surface lifted off the page.</CardBody>
          </Card>
          <Card tone="flat">
            <CardTitle>Flat</CardTitle>
            <CardBody>A hairline only. Quieter, for lists.</CardBody>
          </Card>
          <Card tone="sunken">
            <CardTitle>Sunken</CardTitle>
            <CardBody>Recessed. For asides and quiet context.</CardBody>
          </Card>
        </div>
      </Section>

      <Section title="Form fields" note="Errors are wired to their control with aria-describedby, so screen readers announce them.">
        <div className="grid gap-6 md:max-w-lg">
          <Field label="First name" htmlFor="sg-name" hint="This is how she will be greeted.">
            <Input placeholder="Her name" />
          </Field>
          <Field label="Email" htmlFor="sg-email" error="That address does not look right.">
            <Input defaultValue="not-an-email" />
          </Field>
          <Field label="What happened?" htmlFor="sg-what">
            <Textarea placeholder="However it comes out." />
          </Field>
        </div>
      </Section>

      <Section title="Area marks" note="The four areas as badges — a thin mark, never a filled card.">
        <div className="flex flex-wrap gap-3">
          <Badge area="self">Self</Badge>
          <Badge area="love">Love</Badge>
          <Badge area="life">Life</Badge>
          <Badge area="wealth">Wealth</Badge>
          <Badge>Neutral</Badge>
        </div>
      </Section>

      <Section title="Rules" note="The gilt rule is the only sanctioned use of gold.">
        <div className="space-y-6">
          <div>
            <Rule />
            <p className="mt-1 text-2xs text-ink-faint">default</p>
          </div>
          <div>
            <Rule tone="strong" />
            <p className="mt-1 text-2xs text-ink-faint">strong</p>
          </div>
          <div>
            <Rule tone="gilt" />
            <p className="mt-1 text-2xs text-ink-faint">gilt</p>
          </div>
        </div>
      </Section>

      <Section
        title="Block registry"
        note="A lesson is a list of typed blocks. A new program needs no code; a new block type is one folder plus one registry line."
      >
        <ul className="divide-y divide-rule border-y border-rule">
          {listBlocks().map((block) => (
            <li key={block.type} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
              <code className="text-xs text-clay-deep">{block.type}</code>
              <span className="text-xs font-medium">{block.label}</span>
              <span className="text-2xs text-ink-muted">{block.description}</span>
              {block.isSensitive && (
                <Badge className="border-plum/40 text-plum">encrypted</Badge>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </main>
  )
}

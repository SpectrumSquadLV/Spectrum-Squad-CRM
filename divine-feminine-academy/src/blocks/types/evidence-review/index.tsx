/**
 * Day 7: her own evidence, gathered from the previous six days.
 *
 * No client interactivity, so no split is needed: this is a plain server
 * component and the definition sits beside it.
 *
 * This block is the argument. Not copy about transformation - her sentences,
 * her count, her week. It is also what makes the Divine Feminine invitation land,
 * because it is true.
 */
import { z } from 'zod'
import { Badge, Card, CardBody, CardTitle, Rule } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import type { BlockDefinition, BlockMemberProps } from '../../contract'

const configSchema = z.object({
  prompt: z.string().default('Look at what you did.'),
  helper: z.string().optional(),
})

type Config = z.infer<typeof configSchema>

const isArea = (v: string | null): v is Area =>
  v === 'self' || v === 'love' || v === 'life' || v === 'wealth'

function EvidenceReviewMember({
  config,
  context,
}: BlockMemberProps<Config, undefined>) {
  const evidence = context

  return (
    <div className="measure-wide">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-8">{config.helper}</p>}

      {!evidence ? (
        <p className="text-sm text-ink-muted">Gathering your week…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-px sm:grid-cols-4">
            {[
              { n: evidence.choiceCount, label: 'times you chose HER' },
              { n: evidence.daysCompleted, label: 'days finished' },
              { n: evidence.patterns.length, label: 'patterns named' },
              { n: evidence.journalWordCount, label: 'words written' },
            ].map((stat) => (
              <div key={stat.label} className="border-l-2 border-gilt/40 pl-4 py-2">
                <p className="font-display text-3xl leading-none">{stat.n}</p>
                <p className="mt-2 text-2xs text-ink-muted">{stat.label}</p>
              </div>
            ))}
          </div>

          {evidence.patterns.length > 0 && (
            <>
              <Rule tone="gilt" className="my-12" />
              <h3 className="font-display text-xl">What you named</h3>
              <ul className="mt-6 space-y-6">
                {evidence.patterns.map((p, i) => (
                  <li key={i}>
                    <p className="text-sm text-ink">{p.triggerText}</p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <p className="text-xs text-ink-muted">
                        <span className="text-2xs uppercase tracking-[0.16em]">
                          Then
                        </span>
                        <br />
                        {p.currentResponse}
                      </p>
                      <p className="text-xs text-plum">
                        <span className="text-2xs uppercase tracking-[0.16em]">
                          HER
                        </span>
                        <br />
                        {p.herResponse}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {evidence.choices.length > 0 && (
            <>
              <Rule tone="gilt" className="my-12" />
              <h3 className="font-display text-xl">When you chose her</h3>
              <ul className="mt-6 space-y-4">
                {evidence.choices.map((c, i) => (
                  <li key={i} className="flex flex-col gap-1">
                    {isArea(c.area) && <Badge area={c.area}>{c.area}</Badge>}
                    <p className="text-sm text-ink-soft">{c.situation}</p>
                    <p className="text-sm text-plum">{c.herResponse}</p>
                  </li>
                ))}
              </ul>
            </>
          )}

          {evidence.choiceCount === 0 && evidence.patterns.length === 0 && (
            <Card tone="sunken" className="mt-10">
              <CardTitle className="text-lg">Nothing logged yet</CardTitle>
              <CardBody className="text-xs">
                Go back through the week when you are ready. This page fills
                itself from what you write.
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

export const evidenceReview: BlockDefinition<typeof configSchema, undefined> = {
  type: 'evidence_review',
  label: 'Your evidence',
  description: 'Reads her own week back to her. Display only; no input.',
  configSchema,
  responseSchema: null,
  Member: EvidenceReviewMember,
  isSensitive: false,
  resolvesContext: 'her_evidence',
}

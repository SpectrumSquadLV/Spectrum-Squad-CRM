/**
 * A milestone marker. Display only.
 *
 * Deliberately not gamified: no confetti, no streak counter, no badge. A quiet
 * acknowledgement, because the thing being marked is hers and not ours.
 */
import { z } from 'zod'
import { Rule } from '@/design-system/primitives'
import type { BlockDefinition, BlockMemberProps } from '../../contract'

const configSchema = z.object({
  title: z.string(),
  body: z.string().optional(),
  milestoneSlug: z.string().optional(),
})

type Config = z.infer<typeof configSchema>

function MilestoneMember({ config }: BlockMemberProps<Config, undefined>) {
  return (
    <div className="measure text-center">
      <Rule tone="gilt" />
      <h2 className="mt-10 font-display text-2xl">{config.title}</h2>
      {config.body && (
        <p className="mt-4 text-sm text-ink-soft">{config.body}</p>
      )}
      <Rule tone="gilt" className="mt-10" />
    </div>
  )
}

export const milestone: BlockDefinition<typeof configSchema, undefined> = {
  type: 'milestone',
  label: 'Milestone',
  description: 'A quiet acknowledgement. Display only, deliberately not gamified.',
  configSchema,
  responseSchema: null,
  Member: MilestoneMember,
  isSensitive: false,
}

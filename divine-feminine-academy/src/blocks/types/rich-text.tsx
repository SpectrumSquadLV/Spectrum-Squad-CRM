import { z } from 'zod'
import type { BlockDefinition, BlockMemberProps } from '../contract'

const configSchema = z.object({
  heading: z.string().optional(),
  body: z.string(),
  align: z.enum(['left', 'center']).default('left'),
})

type Config = z.infer<typeof configSchema>

function Member({ config }: BlockMemberProps<Config, undefined>) {
  return (
    <div className={config.align === 'center' ? 'text-center mx-auto measure' : 'measure'}>
      {config.heading && <h2 className="text-2xl mb-4">{config.heading}</h2>}
      {config.body.split('\n\n').map((para, i) => (
        <p key={i} className="mb-5 text-ink-soft last:mb-0">
          {para}
        </p>
      ))}
    </div>
  )
}

export const richText: BlockDefinition<typeof configSchema, undefined> = {
  type: 'rich_text',
  label: 'Text',
  description: 'A heading and body copy. Display only.',
  configSchema,
  responseSchema: null,
  Member,
  isSensitive: false,
}

import { z } from 'zod'
import type { BlockDefinition, BlockMemberProps } from '../../contract'

const configSchema = z.object({
  heading: z.string().optional(),
  body: z.string(),
  align: z.enum(['left', 'center']).default('left'),
})

type Config = z.infer<typeof configSchema>

/**
 * Her own words, dropped into the copy.
 *
 * Day 1 Screen 5 is "THIS HAPPENED: [trigger] AND ME: [me_response]", and it
 * only lands because those are the sentences SHE typed twenty seconds ago.
 * `{{trigger}}` in the body is replaced with what she saved under that name
 * today.
 *
 * A placeholder with nothing behind it renders as nothing rather than as
 * "{{trigger}}": a woman who skipped a screen should never be shown the
 * machinery.
 */
function fill(body: string, today: Record<string, string> | undefined): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    (today?.[name] ?? '').trim(),
  )
}

function Member({ config, today }: BlockMemberProps<Config, undefined>) {
  const body = fill(config.body, today)
  return (
    <div className={config.align === 'center' ? 'text-center mx-auto measure' : 'measure'}>
      {config.heading && <h2 className="text-2xl mb-4">{config.heading}</h2>}
      {body
        .split('\n\n')
        // A paragraph that was nothing but a placeholder she never filled
        // leaves a gap, not an empty line with spacing around it.
        .filter((para) => para.trim() !== '')
        .map((para, i) => (
          <p key={i} className="mb-5 whitespace-pre-line text-ink-soft last:mb-0">
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

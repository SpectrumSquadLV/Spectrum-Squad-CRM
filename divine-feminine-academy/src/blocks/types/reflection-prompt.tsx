'use client'

import { z } from 'zod'
import { Field, Textarea } from '@/design-system/primitives'
import type { BlockDefinition, BlockMemberProps } from '../contract'

/**
 * An open reflection. Marked sensitive, so the response is encrypted like a
 * journal body and admin surfaces see only that it was answered.
 *
 * Days 2 and 3 reach into origin wounds. Those use this block.
 */
const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  placeholder: z.string().optional(),
  minWords: z.number().int().nonnegative().default(0),
  alsoSaveToJournal: z.boolean().default(true),
})

const responseSchema = z.object({ text: z.string() })

type Config = z.infer<typeof configSchema>
type Response = z.infer<typeof responseSchema>

function Member({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const text = value?.text ?? ''
  const words = text.trim() ? text.trim().split(/\s+/).length : 0

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-6">{config.helper}</p>}

      <Field label="Your words" htmlFor={`${blockId}-text`}>
        <Textarea
          value={text}
          placeholder={config.placeholder}
          onChange={(e) => onChange({ text: e.target.value })}
          disabled={disabled}
          rows={10}
        />
      </Field>

      <p className="mt-3 text-2xs text-ink-muted">
        {config.minWords > 0 && words < config.minWords
          ? `${words} of ${config.minWords} words`
          : 'Only you can read this.'}
      </p>
    </div>
  )
}

export const reflectionPrompt: BlockDefinition<typeof configSchema, Response> = {
  type: 'reflection_prompt',
  label: 'Reflection',
  description: 'An open written reflection. Encrypted; only she can read it.',
  configSchema,
  responseSchema,
  Member,
  isSensitive: true,
  writesTo: ['journal_entries'],
}

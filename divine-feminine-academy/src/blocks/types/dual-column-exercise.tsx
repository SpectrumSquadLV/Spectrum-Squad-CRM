'use client'

import { z } from 'zod'
import { Field, Textarea } from '@/design-system/primitives'
import type { BlockDefinition, BlockMemberProps } from '../contract'

/**
 * Day 1: Current Me / HER.
 *
 * The output of this block is the woman's HER profile, which every later
 * program reads from. It is the reason the platform remembers who she is
 * becoming rather than just what she has watched.
 */
const configSchema = z.object({
  prompt: z.string(),
  triggerLabel: z.string().default('What sets this off?'),
  currentLabel: z.string().default('Current Me responds by...'),
  herLabel: z.string().default('HER responds by...'),
  helper: z.string().optional(),
})

const responseSchema = z.object({
  trigger: z.string().min(1),
  currentResponse: z.string().min(1),
  herResponse: z.string().min(1),
})

type Config = z.infer<typeof configSchema>
type Response = z.infer<typeof responseSchema>

function Member({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const current: Response = value ?? {
    trigger: '',
    currentResponse: '',
    herResponse: '',
  }

  const set = (patch: Partial<Response>) => onChange({ ...current, ...patch })

  return (
    <div className="measure-wide">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-8">{config.helper}</p>}

      <Field label={config.triggerLabel} htmlFor={`${blockId}-trigger`} className="mb-8">
        <Textarea
          value={current.trigger}
          onChange={(e) => set({ trigger: e.target.value })}
          disabled={disabled}
          rows={3}
        />
      </Field>

      {/* Stacks on a phone. The two columns are a desktop affordance only. */}
      <div className="grid gap-8 md:grid-cols-2">
        <Field label={config.currentLabel} htmlFor={`${blockId}-current`}>
          <Textarea
            value={current.currentResponse}
            onChange={(e) => set({ currentResponse: e.target.value })}
            disabled={disabled}
          />
        </Field>
        <Field label={config.herLabel} htmlFor={`${blockId}-her`}>
          <Textarea
            value={current.herResponse}
            onChange={(e) => set({ herResponse: e.target.value })}
            disabled={disabled}
            className="border-plum/30 focus:border-plum"
          />
        </Field>
      </div>
    </div>
  )
}

export const dualColumnExercise: BlockDefinition<typeof configSchema, Response> = {
  type: 'dual_column_exercise',
  label: 'Current Me / HER',
  description:
    'Two columns: how she responds now, how HER responds. Writes to her HER profile.',
  configSchema,
  responseSchema,
  Member,
  isSensitive: false,
  writesTo: ['her_patterns'],
}

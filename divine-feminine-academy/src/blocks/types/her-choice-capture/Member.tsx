'use client'

import { Badge, Field, Textarea } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

const areas: Area[] = ['self', 'love', 'life', 'wealth']
const empty: Response = { situation: '', oldResponse: '', herResponse: '' }

export function HerChoiceCaptureMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const current = value ?? empty
  const set = (patch: Partial<Response>) => onChange({ ...current, ...patch })

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-8">{config.helper}</p>}

      <div className="flex flex-col gap-7">
        <Field label="What happened" htmlFor={`${blockId}-situation`}>
          <Textarea
            value={current.situation}
            onChange={(e) => set({ situation: e.target.value })}
            disabled={disabled}
            rows={3}
          />
        </Field>

        <Field label="What you would have done before" htmlFor={`${blockId}-old`}>
          <Textarea
            value={current.oldResponse}
            onChange={(e) => set({ oldResponse: e.target.value })}
            disabled={disabled}
            rows={2}
          />
        </Field>

        <Field label="What you did instead" htmlFor={`${blockId}-her`}>
          <Textarea
            value={current.herResponse}
            onChange={(e) => set({ herResponse: e.target.value })}
            disabled={disabled}
            rows={3}
            className="border-plum/30 focus:border-plum"
          />
        </Field>

        <fieldset>
          <legend className="text-xs font-medium text-ink-soft">Where</legend>
          <div className="mt-3 flex flex-wrap gap-2">
            {areas.map((area) => (
              <button
                key={area}
                type="button"
                disabled={disabled}
                aria-pressed={current.area === area}
                onClick={() => set({ area })}
                className="min-h-11 rounded-sm"
              >
                <Badge
                  area={area}
                  className={current.area === area ? 'ring-1 ring-plum/40' : 'opacity-60'}
                >
                  {area}
                </Badge>
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  )
}

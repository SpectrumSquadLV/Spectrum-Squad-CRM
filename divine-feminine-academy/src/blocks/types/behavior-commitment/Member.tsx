'use client'

import { Badge, Field, Textarea } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

const areas: Area[] = ['self', 'love', 'life', 'wealth']
const empty: Response = { behaviour: '', instead: '', nextTime: '' }

export function BehaviorCommitmentMember({
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

      <div className="flex flex-col gap-8">
        <Field label="The thing you keep doing" htmlFor={`${blockId}-behaviour`}>
          <Textarea
            value={current.behaviour}
            onChange={(e) => set({ behaviour: e.target.value })}
            disabled={disabled}
            rows={3}
          />
        </Field>

        <Field label="What HER does instead" htmlFor={`${blockId}-instead`}>
          <Textarea
            value={current.instead}
            onChange={(e) => set({ instead: e.target.value })}
            disabled={disabled}
            rows={3}
            className="border-plum/30 focus:border-plum"
          />
        </Field>

        <Field
          label="The next time it comes up, specifically"
          htmlFor={`${blockId}-next`}
          hint="Name the situation. A promise you cannot check is not a commitment."
        >
          <Textarea
            value={current.nextTime}
            onChange={(e) => set({ nextTime: e.target.value })}
            disabled={disabled}
            rows={3}
          />
        </Field>

        <fieldset>
          <legend className="text-xs font-medium text-ink-soft">
            Which part of your life?
          </legend>
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
                  className={
                    current.area === area ? 'ring-1 ring-plum/40' : 'opacity-60'
                  }
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

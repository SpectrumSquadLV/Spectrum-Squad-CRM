'use client'

import { Field, Input, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import { type Config, type ReturnAction, type Response, returnActions } from './schema'

const empty: Response = {
  whatHappened: '',
  feeling: '',
  meaningMade: '',
  isItTrue: '',
  whatINeed: '',
}

const labels: Record<ReturnAction, string> = {
  dance: 'Dance',
  create: 'Create',
  move: 'Move',
  music: 'Music',
  nature: 'Nature',
  play: 'Play',
  rest: 'Rest',
  connect: 'Connect',
  journal: 'Journal',
  custom: 'Something else',
}

/**
 * Deliberately plain. She is at low capacity here: large targets, few words,
 * nothing that reads as cheerful.
 */
export function ReturnPracticeMember({
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
        <Field label="What happened" htmlFor={`${blockId}-what`}>
          <Textarea
            value={current.whatHappened}
            onChange={(e) => set({ whatHappened: e.target.value })}
            disabled={disabled}
            rows={4}
          />
        </Field>

        <Field label="What you are feeling" htmlFor={`${blockId}-feeling`}>
          <Input
            value={current.feeling}
            onChange={(e) => set({ feeling: e.target.value })}
            disabled={disabled}
          />
        </Field>

        <Field label="What you are making it mean" htmlFor={`${blockId}-meaning`}>
          <Textarea
            value={current.meaningMade}
            onChange={(e) => set({ meaningMade: e.target.value })}
            disabled={disabled}
            rows={3}
          />
        </Field>

        <Field
          label="Is that necessarily true?"
          htmlFor={`${blockId}-true`}
          hint="Not whether it feels true. Whether it is."
        >
          <Textarea
            value={current.isItTrue}
            onChange={(e) => set({ isItTrue: e.target.value })}
            disabled={disabled}
            rows={3}
          />
        </Field>

        <Field label="What you need right now" htmlFor={`${blockId}-need`}>
          <Textarea
            value={current.whatINeed}
            onChange={(e) => set({ whatINeed: e.target.value })}
            disabled={disabled}
            rows={3}
          />
        </Field>

        <fieldset>
          <legend className="text-xs font-medium text-ink-soft">
            What would help you return
          </legend>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {returnActions.map((action) => (
              <button
                key={action}
                type="button"
                disabled={disabled}
                aria-pressed={current.actionChosen === action}
                onClick={() => set({ actionChosen: action })}
                className={cn(
                  'min-h-14 rounded-md border px-3 text-sm transition-colors',
                  current.actionChosen === action
                    ? 'border-plum bg-plum-wash text-plum'
                    : 'border-rule-strong bg-alabaster text-ink-soft hover:border-clay',
                )}
              >
                {labels[action]}
              </button>
            ))}
          </div>
        </fieldset>

        {current.actionChosen === 'custom' && (
          <Field label="Name it" htmlFor={`${blockId}-custom`}>
            <Input
              value={current.customAction ?? ''}
              onChange={(e) => set({ customAction: e.target.value })}
              disabled={disabled}
            />
          </Field>
        )}
      </div>

      <CrisisResources className="mt-10" />
    </div>
  )
}

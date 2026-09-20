'use client'

import { Field, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

const EMPTY: Response = {
  belief: '',
  origin: '',
  evidenceFor: '',
  evidenceAgainst: '',
  direction: 'not sure',
  verdict: 'not yet',
}

const DIRECTIONS: Array<{ value: Response['direction']; label: string }> = [
  { value: 'closer', label: 'Closer to HER' },
  { value: 'further', label: 'Further away' },
  { value: 'not sure', label: 'Not sure yet' },
]

const VERDICTS: Array<{ value: Response['verdict']; label: string }> = [
  { value: 'releasing', label: 'I am letting it go' },
  { value: 'carrying', label: 'I am still carrying it' },
  { value: 'not yet', label: 'Not yet' },
]

export function BeliefReviewMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const merged: Response = { ...EMPTY, ...(value ?? {}) }
  const set = <K extends keyof Response>(key: K, v: Response[K]) =>
    onChange({ ...merged, [key]: v })

  const Choice = <K extends keyof Response>({
    field,
    options,
  }: {
    field: K
    options: Array<{ value: Response[K]; label: string }>
  }) => (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={merged[field] === o.value}
          disabled={disabled}
          onClick={() => set(field, o.value)}
          className={cn(
            'min-h-11 rounded-full border px-4 text-sm transition-colors',
            merged[field] === o.value
              ? 'border-plum bg-plum-wash text-plum'
              : 'border-rule-strong bg-alabaster text-ink-soft hover:border-clay',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && (
        <p className="mb-8 text-sm text-ink-muted">{config.helper}</p>
      )}

      <div className="flex flex-col gap-6">
        <Field label={config.beliefLabel} htmlFor={`${blockId}-belief`}>
          <Textarea
            id={`${blockId}-belief`}
            value={merged.belief}
            onChange={(e) => set('belief', e.target.value)}
            disabled={disabled}
            rows={3}
          />
        </Field>

        <Field label={config.originLabel} htmlFor={`${blockId}-origin`}>
          <Textarea
            id={`${blockId}-origin`}
            value={merged.origin}
            onChange={(e) => set('origin', e.target.value)}
            disabled={disabled}
            rows={4}
          />
        </Field>

        <Field label={config.forLabel} htmlFor={`${blockId}-for`}>
          <Textarea
            id={`${blockId}-for`}
            value={merged.evidenceFor}
            onChange={(e) => set('evidenceFor', e.target.value)}
            disabled={disabled}
            rows={4}
          />
        </Field>

        {/* The one she has never been asked. Given the most room on purpose. */}
        <Field label={config.againstLabel} htmlFor={`${blockId}-against`}>
          <Textarea
            id={`${blockId}-against`}
            value={merged.evidenceAgainst}
            onChange={(e) => set('evidenceAgainst', e.target.value)}
            disabled={disabled}
            rows={8}
          />
        </Field>
      </div>

      <fieldset className="mt-10">
        <legend className="text-2xs uppercase tracking-[0.15em] text-ink-muted">
          {config.directionLabel}
        </legend>
        <div className="mt-4">
          <Choice field="direction" options={DIRECTIONS} />
        </div>
      </fieldset>

      <fieldset className="mt-8">
        <legend className="text-2xs uppercase tracking-[0.15em] text-ink-muted">
          So what are you doing with it?
        </legend>
        <div className="mt-4">
          <Choice field="verdict" options={VERDICTS} />
        </div>
        <p className="mt-3 text-2xs text-ink-faint">
          Still carrying it is a real answer. Some beliefs take more than a
          Thursday.
        </p>
      </fieldset>

      <p className="mt-8 text-2xs text-ink-muted">Only you can read this.</p>
      <CrisisResources className="mt-10" />
    </div>
  )
}

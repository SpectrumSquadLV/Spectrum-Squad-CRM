'use client'

import { Field, Input, Textarea } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import { STRATEGIES, type Config, type Response } from './schema'

export function MePortraitMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const current: Response = {
    name: value?.name ?? '',
    trigger: value?.trigger ?? '',
    strategies: value?.strategies ?? [],
  }

  const toggle = (s: string) =>
    onChange({
      ...current,
      strategies: current.strategies.includes(s)
        ? current.strategies.filter((x) => x !== s)
        : [...current.strategies, s],
    })

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && (
        <p className="mb-8 text-sm text-ink-muted">{config.helper}</p>
      )}

      <Field label={config.nameLabel} htmlFor={`${blockId}-name`}>
        <Input
          id={`${blockId}-name`}
          value={current.name}
          onChange={(e) => onChange({ ...current, name: e.target.value })}
          disabled={disabled}
        />
      </Field>

      <Field
        label={config.triggerLabel}
        htmlFor={`${blockId}-trigger`}
        className="mt-6"
      >
        <Textarea
          id={`${blockId}-trigger`}
          value={current.trigger}
          onChange={(e) => onChange({ ...current, trigger: e.target.value })}
          disabled={disabled}
          rows={3}
        />
      </Field>

      <fieldset className="mt-8">
        <legend className="text-2xs uppercase tracking-[0.15em] text-ink-muted">
          {config.strategiesLabel}
        </legend>
        <div className="mt-4 flex flex-wrap gap-2">
          {STRATEGIES.map((s) => {
            const on = current.strategies.includes(s)
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => toggle(s)}
                className={cn(
                  'min-h-11 rounded-full border px-4 text-sm transition-colors',
                  on
                    ? 'border-plum bg-plum-wash text-plum'
                    : 'border-rule-strong bg-alabaster text-ink-soft hover:border-clay',
                )}
              >
                {s}
              </button>
            )
          })}
        </div>
      </fieldset>

      <p className="mt-8 text-2xs text-ink-muted">
        None of this is a flaw. Every one of them worked at the time.
      </p>
    </div>
  )
}

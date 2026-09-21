'use client'

import { Field, Textarea } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

/**
 * Tapping, not writing.
 *
 * Day 1 has to be QUICK. A woman meeting ME for the first time will not open
 * with a paragraph about herself, but she will happily tap nine things she
 * recognises — and tapping nine things she recognises IS the recognition the
 * day is after. The write-your-own box is there for the one that is hers
 * alone, not as the main event.
 *
 * Nothing here is scored and nothing is ranked. Day 1 says so on the screen,
 * and the component must not quietly contradict it with a counter that looks
 * like a total.
 */
export function PatternSelectMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
  today,
}: BlockMemberProps<Config, Response>) {
  const selected = value?.selected ?? []
  const custom = value?.custom ?? ''

  /*
   * Day 4 shows the list for the area she picked one screen ago. If she has
   * not picked one yet, say so plainly rather than rendering an empty list
   * that looks broken.
   */
  const area = config.readsArea ? today?.[config.readsArea] : undefined
  const options = config.optionsByArea
    ? area
      ? (config.optionsByArea[area as keyof typeof config.optionsByArea] ?? [])
      : []
    : config.options

  const toggle = (option: string) => {
    onChange({
      selected: selected.includes(option)
        ? selected.filter((s) => s !== option)
        : [...selected, option],
      custom,
    })
  }

  return (
    <div className="measure">
      <h2 className="mb-3 font-display text-2xl leading-snug">{config.prompt}</h2>
      {config.helper && (
        <p className="mb-6 whitespace-pre-line text-sm text-ink-muted">
          {config.helper}
        </p>
      )}

      {config.optionsByArea && !area ? (
        <p className="mt-6 text-sm text-ink-muted">
          Choose an area on the screen before this one first.
        </p>
      ) : (
        <ul className="mt-6 flex flex-wrap gap-2">
          {options.map((option) => {
            const active = selected.includes(option)
            return (
              <li key={option}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  onClick={() => toggle(option)}
                  className={cn(
                    'min-h-11 rounded-full border px-4 py-2 text-left text-sm transition-colors',
                    active
                      ? 'border-plum bg-plum text-bone'
                      : 'border-rule-strong bg-transparent text-ink-soft hover:border-clay hover:text-clay-deep',
                    disabled && 'opacity-60',
                  )}
                >
                  {option}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {config.allowCustom && (
        <div className="mt-8">
          <Field label={config.customLabel} htmlFor={`${blockId}-custom`}>
            <Textarea
              id={`${blockId}-custom`}
              value={custom}
              onChange={(e) => onChange({ selected, custom: e.target.value })}
              disabled={disabled}
              rows={3}
            />
          </Field>
        </div>
      )}
    </div>
  )
}

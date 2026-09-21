'use client'

import { areas, areaLabels, type Area } from '@/features/assessment/scoring'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

/**
 * Four tiles, and nothing else on the screen.
 *
 * Deliberately not a dropdown and not radio buttons: this is the moment the
 * day turns from reading to looking, and it should feel like choosing a door.
 * Each tile carries its area's hairline so the colour she sees here is the
 * same one she sees on her results and in her journal.
 */
const tileRule: Record<Area, string> = {
  herself: 'border-l-area-herself',
  relationships: 'border-l-area-relationships',
  money: 'border-l-area-money',
  success: 'border-l-area-success',
}

export function AreaPickerMember({
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const chosen = value?.area as Area | undefined

  return (
    <div className="measure">
      <h2 className="mb-3 font-display text-2xl leading-snug">{config.prompt}</h2>
      {config.helper && (
        <p className="mb-6 text-sm text-ink-muted">{config.helper}</p>
      )}

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {areas.map((area) => {
          const active = chosen === area
          return (
            <li key={area}>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() =>
                  onChange({
                    area,
                    // Looking at a second area does not erase the first.
                    alsoExplored:
                      chosen && chosen !== area
                        ? [...new Set([...(value?.alsoExplored ?? []), chosen])]
                        : (value?.alsoExplored ?? []),
                  })
                }
                className={cn(
                  'flex min-h-24 w-full items-center rounded-xl border border-l-4 px-5 py-4 text-left font-display text-lg transition-colors',
                  tileRule[area],
                  active
                    ? 'border-clay bg-alabaster text-ink shadow-raised'
                    : 'border-rule bg-transparent text-ink-soft hover:border-rule-strong hover:text-ink',
                  disabled && 'opacity-60',
                )}
              >
                {areaLabels[area]}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

'use client'

import { useEffect } from 'react'
import { areas, areaLabels, type Area } from '@/features/assessment/scoring'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

/**
 * The lightest screen in the challenge, and the one she screenshots.
 *
 * Days 1 to 4 are introspection and they look it. Day 5 has to feel like a
 * window opening, so this is the one place in the seven days with real air in
 * it: wide leading, generous space between the four, and her own sentences
 * set in display type rather than as form values.
 *
 * It shows her nothing she did not write. That is the point of the closing
 * line — she did not create HER today, she gave herself permission to see
 * her.
 */
const rule: Record<Area, string> = {
  herself: 'border-area-herself',
  relationships: 'border-area-relationships',
  money: 'border-area-money',
  success: 'border-area-success',
}

export function HerRevealMember({
  config,
  value,
  onChange,
  today,
}: BlockMemberProps<Config, Response>) {
  /*
   * Collect the four from the screens before this one and hand them to the
   * side effect that stores them.
   *
   * Written on render rather than behind a button because there is no button
   * on this screen: she reads it and moves on. Only fires when what she wrote
   * differs from what is already saved, so it does not loop.
   */
  const collected: Record<string, string> = {}
  for (const area of areas) {
    const name = config.readsFrom[area]
    const text = name ? (today?.[name] ?? '').trim() : ''
    if (text) collected[area] = text
  }

  const saved = value?.desires ?? {}
  const changed =
    areas.some((a) => (collected[a] ?? '') !== (saved[a] ?? '')) &&
    Object.keys(collected).length > 0

  useEffect(() => {
    if (changed) onChange({ desires: collected })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed, JSON.stringify(collected)])

  const shown = Object.keys(collected).length > 0 ? collected : saved
  const present = areas.filter((a) => (shown[a] ?? '').trim() !== '')

  return (
    <div className="measure">
      <h2 className="font-display text-3xl leading-tight tracking-tight md:text-4xl">
        {config.heading}
      </h2>

      {present.length === 0 ? (
        <p className="mt-8 text-sm text-ink-muted">
          Your four answers will appear here once you have written them.
        </p>
      ) : (
        <dl className="mt-10 space-y-8">
          {present.map((area) => (
            <div key={area} className={`border-l-2 pl-5 ${rule[area]}`}>
              <dt className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
                {areaLabels[area]}
              </dt>
              <dd className="mt-3 whitespace-pre-line font-display text-xl leading-relaxed text-ink md:text-2xl">
                {shown[area]}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {config.close && (
        <div className="mt-12 space-y-5">
          {config.close.split('\n\n').map((para, i) => (
            <p key={i} className="whitespace-pre-line text-ink-soft">
              {para}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

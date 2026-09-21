'use client'

import type { BlockMemberProps } from '../../contract'
import type { Config } from './schema'

export function CelebrationMember({
  config,
  context,
}: BlockMemberProps<Config, undefined>) {
  const stats: Array<{ value: number; label: string }> = []

  if (context) {
    if (config.showDays && context.daysCompleted > 0) {
      stats.push({
        value: context.daysCompleted,
        label: context.daysCompleted === 1 ? 'day' : 'days',
      })
    }
    if (config.showChoices && context.choiceCount > 0) {
      stats.push({
        value: context.choiceCount,
        label: context.choiceCount === 1 ? 'time you chose her' : 'times you chose her',
      })
    }
    if (config.showWords && context.journalWordCount > 0) {
      stats.push({ value: context.journalWordCount, label: 'words, all yours' })
    }
  }

  return (
    <section className="measure rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
      <h2 className="font-display text-2xl leading-snug md:text-3xl">
        {config.heading}
      </h2>
      {config.body && (
        <p className="mt-4 text-lg leading-relaxed text-ink-soft">{config.body}</p>
      )}

      {stats.length > 0 && (
        <ul className="mt-8 flex flex-wrap gap-10">
          {stats.map((s) => (
            <li key={s.label}>
              <p className="font-display text-4xl tabular-nums">{s.value}</p>
              <p className="mt-1 text-2xs uppercase tracking-[0.15em] text-ink-muted">
                {s.label}
              </p>
            </li>
          ))}
        </ul>
      )}

      {config.footnote && (
        <p className="mt-8 text-sm text-ink-muted">{config.footnote}</p>
      )}
    </section>
  )
}

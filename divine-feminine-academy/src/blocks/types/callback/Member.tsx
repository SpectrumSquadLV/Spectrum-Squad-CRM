'use client'

import { areaLabels } from '@/features/assessment/scoring'
import type { BlockMemberProps } from '../../contract'
import type { Config } from './schema'

export function CallbackMember({
  config,
  context,
}: BlockMemberProps<Config, undefined>) {
  const lines: string[] = []

  if (context) {
    if (config.facet === 'trigger') {
      lines.push(...context.patterns.map((p) => p.triggerText).filter(Boolean))
    } else if (config.facet === 'me_response') {
      lines.push(
        ...context.patterns
          .map((p) => p.currentResponse ?? '')
          .filter((s) => s.trim() !== ''),
      )
    } else if (config.facet === 'her_response') {
      lines.push(
        ...context.patterns
          .map((p) => p.herResponse ?? '')
          .filter((s) => s.trim() !== ''),
      )
    } else if (config.facet === 'desires') {
      lines.push(
        ...context.desires
          .map((d) => `${areaLabels[d.area]} — ${d.text}`)
          .filter((s) => s.trim() !== ''),
      )
    } else {
      lines.push(
        ...context.choices
          .map((c) => c.herResponse ?? c.situation ?? '')
          .filter((s) => s.trim() !== ''),
      )
    }
  }

  // Nothing to show is not an error, and an empty box would be worse than
  // nothing. A woman who skipped a day should not be told off by a widget.
  if (lines.length === 0) {
    return config.emptyText ? (
      <p className="measure text-sm text-ink-muted">{config.emptyText}</p>
    ) : null
  }

  const list = (
    <ul className="mt-5 space-y-4">
      {lines.slice(0, 5).map((line, i) => (
        <li
          key={i}
          className="border-l-2 border-gilt pl-5 font-display text-lg leading-snug"
        >
          {line}
        </li>
      ))}
    </ul>
  )

  /*
   * Collapsed, when the screen has its own job to do.
   *
   * Day 6 asks for ONE small choice, and four paragraphs of everything she
   * wants would swamp that. A native <details> so it works without
   * JavaScript, opens to the keyboard, and is announced properly.
   */
  if (config.collapsed) {
    return (
      <details className="measure rounded-xl border border-rule bg-alabaster p-6 md:p-8">
        <summary className="min-h-11 cursor-pointer list-none text-2xs uppercase tracking-[0.2em] text-clay-deep marker:content-['']">
          {config.heading}
        </summary>
        {list}
      </details>
    )
  }

  return (
    <aside className="measure rounded-xl border border-rule bg-alabaster p-6 md:p-8">
      <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
        {config.heading}
      </p>
      {list}
    </aside>
  )
}

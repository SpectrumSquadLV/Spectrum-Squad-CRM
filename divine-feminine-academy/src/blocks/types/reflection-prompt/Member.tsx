'use client'

import { Field, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

export function ReflectionMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
  today,
}: BlockMemberProps<Config, Response>) {
  const text = value?.text ?? ''
  const words = text.trim() ? text.trim().split(/\s+/).length : 0

  /*
   * Her own words from an earlier screen today, above the prompt.
   *
   * Day 1 asks what happened and then asks what ME did - and the second
   * question only works while the first answer is still on the screen. Day 6
   * and Day 7 do the same with the situation and the decision.
   */
  const earlier = config.showsEarlier
    ? (today?.[config.showsEarlier] ?? '').trim()
    : ''

  return (
    <div className="measure">
      {earlier && (
        <div className="mb-8 border-l-2 border-gilt pl-5">
          {config.showsEarlierLabel && (
            <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
              {config.showsEarlierLabel}
            </p>
          )}
          <p className="mt-2 whitespace-pre-line font-display text-lg leading-snug">
            {earlier}
          </p>
        </div>
      )}

      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && (
        <p className="text-ink-muted text-sm mb-6 whitespace-pre-line">
          {config.helper}
        </p>
      )}

      <Field label="Your words" htmlFor={`${blockId}-text`}>
        <Textarea
          value={text}
          placeholder={config.placeholder}
          onChange={(e) => onChange({ text: e.target.value })}
          disabled={disabled}
          rows={10}
        />
      </Field>

      <p className="mt-3 text-2xs text-ink-muted">
        {config.minWords > 0 && words < config.minWords
          ? `${words} of ${config.minWords} words`
          : 'Only you can read this.'}
      </p>

      {/*
        Duty of care. These prompts go to painful places, and nobody is
        monitoring what she writes - so the way out has to be on the page.
      */}
      <CrisisResources className="mt-8" />

      {config.allowStopForToday && (
        <p className="mt-6">
          <a
            href="/my-academy"
            className="inline-flex min-h-11 items-center text-2xs text-ink-muted underline underline-offset-4 hover:text-ink"
          >
            Save and stop for today
          </a>
        </p>
      )}
    </div>
  )
}

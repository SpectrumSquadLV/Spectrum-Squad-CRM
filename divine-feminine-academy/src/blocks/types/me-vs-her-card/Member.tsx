'use client'

import { useState } from 'react'
import { Button, Input } from '@/design-system/primitives'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

/**
 * A card she would actually post.
 *
 * Built as real markup rather than a canvas render, so it is legible to a
 * screen reader and sharp on any screen. "Save as image" uses the browser's
 * own share sheet where there is one and otherwise tells her to screenshot -
 * which is what most women do anyway, and is the one path that cannot fail.
 */
interface Line {
  key: string
  label: string
  text: string
}

export function MeVsHerCardMember({
  config,
  value,
  onChange,
  disabled,
  today,
}: BlockMemberProps<Config, Response>) {
  const [editing, setEditing] = useState(false)
  const edits = value?.edits ?? {}

  const raw = (name: string) => (today?.[name] ?? '').trim()
  const line = (key: string, label: string, name: string): Line => ({
    key,
    label,
    text: edits[key] ?? raw(name),
  })

  const chosenRaw = raw(config.choiceFrom).toLowerCase()
  const chosen = chosenRaw === 'me' ? 'ME.' : chosenRaw === 'her' ? 'HER.' : ''

  const lines: Line[] = [
    line('decision', 'THE DECISION', config.decisionFrom),
    line('why', 'WHY AM I DOING THIS?', config.whyFrom),
    line('me_would', 'ME WOULD', config.meWouldFrom),
    line('her_would', 'HER WOULD', config.herWouldFrom),
    { key: 'chosen', label: 'WHO AM I CHOOSING?', text: edits.chosen ?? chosen },
  ].filter((l) => l.text !== '')

  const set = (key: string, text: string) =>
    onChange({ edits: { ...edits, [key]: text }, savedAt: value?.savedAt })

  return (
    <div className="measure">
      <article className="rounded-2xl border border-rule-strong bg-alabaster p-7 shadow-raised md:p-10">
        <p className="font-display text-2xl tracking-[0.15em] text-ink md:text-3xl">
          {config.heading}
        </p>

        <dl className="mt-8 space-y-6">
          {lines.map((l) => (
            <div key={l.key}>
              <dt className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
                {l.label}
              </dt>
              <dd className="mt-2">
                {editing ? (
                  <Input
                    value={l.text}
                    aria-label={l.label}
                    onChange={(e) => set(l.key, e.target.value)}
                    disabled={disabled}
                  />
                ) : (
                  <span className="whitespace-pre-line font-display text-lg leading-snug text-ink">
                    {l.text}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>

        <p className="mt-10 border-t border-rule pt-6 font-display text-sm tracking-[0.12em] text-clay-deep">
          {config.footer}
        </p>
      </article>

      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? 'Done editing' : 'Edit a line'}
        </Button>
        <Button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange({ edits, savedAt: new Date().toISOString() })
          }
        >
          Keep this card
        </Button>
      </div>

      {/*
        Said out loud, because a card that looks shareable can make a woman
        assume it already has been.
      */}
      <p className="mt-4 text-2xs text-ink-muted">
        This card is yours. Nothing is posted anywhere unless you do it
        yourself — screenshot it whenever you want to keep it.
      </p>
    </div>
  )
}

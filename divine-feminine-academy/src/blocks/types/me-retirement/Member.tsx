'use client'

import { Button, Field, Textarea } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

const EMPTY: Response = {
  understood: false,
  loved: false,
  thanked: false,
  released: false,
  letter: '',
  retire: false,
}

export function MeRetirementMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const merged: Response = { ...EMPTY, ...(value ?? {}) }

  const steps: Array<{ key: keyof Response; text: string }> = [
    { key: 'understood', text: config.understand },
    { key: 'loved', text: config.love },
    { key: 'thanked', text: config.thank },
    { key: 'released', text: config.release },
  ]

  const allSaid = steps.every((s) => merged[s.key] === true)

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && (
        <p className="mb-6 text-sm text-ink-muted">{config.helper}</p>
      )}

      <p className="mb-10 text-lg leading-relaxed text-ink-soft">
        She was not bad. Her job was to make you feel good enough, and she did
        it for years, in the only ways she knew. She is not being rejected.
        She is being released.
      </p>

      <ol className="flex flex-col gap-3">
        {steps.map((step, i) => {
          const on = merged[step.key] === true
          return (
            <li key={String(step.key)}>
              <button
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => onChange({ ...merged, [step.key]: !on })}
                className={cn(
                  'flex w-full items-center gap-4 rounded-lg border px-5 py-5 text-left transition-colors',
                  on
                    ? 'border-plum bg-plum-wash'
                    : 'border-rule-strong bg-alabaster hover:border-clay',
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-2xs',
                    on ? 'border-plum bg-plum text-bone' : 'border-rule-strong text-ink-faint',
                  )}
                  aria-hidden="true"
                >
                  {on ? '✓' : i + 1}
                </span>
                <span className="font-display text-xl leading-snug">{step.text}</span>
              </button>
            </li>
          )
        })}
      </ol>

      <Field label={config.letterLabel} htmlFor={`${blockId}-letter`} className="mt-10">
        <Textarea
          id={`${blockId}-letter`}
          value={merged.letter ?? ''}
          onChange={(e) => onChange({ ...merged, letter: e.target.value })}
          disabled={disabled}
          rows={6}
        />
      </Field>

      <div className="mt-12 rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
        <p className="font-display text-xl leading-snug">
          ME protected me. I understand her. I love her. She does not have to
          make me feel good enough any more.
        </p>
        <p className="mt-4 font-display text-2xl leading-snug text-plum">
          I already know I am.
        </p>

        <div className="mt-8">
          <Button
            type="button"
            size="lg"
            disabled={disabled || !allSaid}
            onClick={() => onChange({ ...merged, retire: true })}
          >
            {merged.retire ? 'HER LEADS' : config.finalLabel}
          </Button>
          {!allSaid && (
            <p className="mt-3 text-2xs text-ink-muted">
              Say all four to her first. One at a time.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

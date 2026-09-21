'use client'

import { useState } from 'react'
import { Button } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

/**
 * Two buttons of exactly equal weight.
 *
 * They share a variant, a size and a width. The only thing that changes when
 * she picks one is which one is marked as pressed. Making HER the primary
 * button and ME the quiet one would answer the question for her, on the one
 * screen in the whole product where that would be a betrayal of the method.
 */
export function ChoiceCaptureMember({
  config,
  value,
  onChange,
  disabled,
  today,
}: BlockMemberProps<Config, Response>) {
  const chosen = value?.chosen ?? null
  const confirmed = value?.confirmed ?? false

  /*
   * The decision this choice is about, carried into her HER profile.
   *
   * `herResponse` is only ever set when she chose HER: "You've chosen HER n
   * times" counts HER, and the side effect writes nothing without it. A
   * woman who consciously chooses ME has her answer recorded on the block
   * like every other answer, and her counter stays honest.
   */
  const carry = (who: 'me' | 'her' | null) => ({
    situation: (today?.[config.decisionFrom] ?? '').trim(),
    oldResponse: (today?.[config.meWouldFrom] ?? '').trim(),
    herResponse:
      who === 'her' ? (today?.[config.herWouldFrom] ?? '').trim() : '',
  })

  // She tapped ME and has not yet said whether she means it.
  const [reconsidering, setReconsidering] = useState(
    chosen === 'me' && !confirmed,
  )

  const choose = (who: 'me' | 'her') => {
    if (who === 'her') {
      onChange({
        chosen: 'her',
        confirmed: true,
        chosenAt: new Date().toISOString(),
        ...carry('her'),
      })
      setReconsidering(false)
      return
    }
    // ME is never confirmed on the first tap. She gets one more look first.
    onChange({
      chosen: 'me',
      confirmed: false,
      chosenAt: new Date().toISOString(),
      ...carry('me'),
    })
    setReconsidering(true)
  }

  return (
    <div className="measure">
      <h2 className="font-display text-3xl leading-tight tracking-tight md:text-4xl">
        {config.prompt}
      </h2>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {(['me', 'her'] as const).map((who) => {
          const label = who === 'me' ? config.meLabel : config.herLabel
          const active = chosen === who
          return (
            <Button
              key={who}
              type="button"
              variant="secondary"
              size="lg"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => choose(who)}
              className={cn(
                'w-full justify-center font-display text-2xl tracking-tight',
                active && 'border-clay bg-linen text-ink',
              )}
            >
              {label}
            </Button>
          )
        })}
      </div>

      {reconsidering && config.meResponse && (
        <div className="mt-10 rounded-xl border border-rule bg-alabaster p-6">
          {config.meResponse.split('\n\n').map((para, i) => (
            <p key={i} className="mb-4 whitespace-pre-line text-ink-soft last:mb-0">
              {para}
            </p>
          ))}

          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              onClick={() => {
                // Back to two equal buttons, with nothing chosen.
                onChange({ chosen: null, confirmed: false, ...carry(null) })
                setReconsidering(false)
              }}
            >
              {config.lookAgainLabel}
            </Button>
            <Button
              type="button"
              variant="quiet"
              disabled={disabled}
              onClick={() => {
                onChange({
                  chosen: 'me',
                  confirmed: true,
                  chosenAt: value?.chosenAt ?? new Date().toISOString(),
                  ...carry('me'),
                })
                setReconsidering(false)
              }}
            >
              {config.continueWithMeLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

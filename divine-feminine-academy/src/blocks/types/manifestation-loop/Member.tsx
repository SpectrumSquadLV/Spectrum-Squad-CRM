'use client'

import { useState } from 'react'
import { Button, Field, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import { LOOP_STEPS, type Config, type Response } from './schema'

const EMPTY: Response = {
  experience: '',
  meaning: '',
  belief: '',
  expectation: '',
  attention: '',
  evidence: '',
  stronger: '',
}

export function ManifestationLoopMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const merged: Response = { ...EMPTY, ...(value ?? {}) }
  const [step, setStep] = useState(0)

  const current = LOOP_STEPS[Math.min(step, LOOP_STEPS.length - 1)]!
  const label = config.labels?.[current.key] ?? current.label
  const isLast = step === LOOP_STEPS.length - 1

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && (
        <p className="mb-6 text-sm text-ink-muted">{config.helper}</p>
      )}

      {/*
        FIXED FRAMING. Not editable in the admin, and not optional.

        This is the one screen in the challenge where the manifestation model
        could be misread as "you caused this". The methodology draws the line
        explicitly: nothing here implies a woman caused abuse, trauma, illness,
        poverty, discrimination, or another person's behaviour. The empowering
        claim is much narrower and much more useful - the part of the pattern
        that belongs to her is the part she can change.

        Leaving this to editable copy would mean one rushed edit could remove
        it, on the single screen where it matters most.
      */}
      <p className="mb-10 rounded-lg border border-rule bg-alabaster px-5 py-4 text-sm leading-relaxed text-ink-soft">
        This is not about what you caused. Things happen to women that they did
        nothing to deserve and could not have prevented. This is about the part
        of the pattern that belongs to you — because that is the part you can
        reach.
      </p>

      <ol className="mb-8 flex gap-1.5" aria-label="Progress through the loop">
        {LOOP_STEPS.map((s, i) => (
          <li
            key={s.key}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'h-0.5 flex-1 rounded-full',
              i < step && 'bg-clay',
              i === step && 'bg-plum',
              i > step && 'bg-rule',
            )}
          />
        ))}
      </ol>

      <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
        {step + 1} of {LOOP_STEPS.length}
      </p>

      <Field label={label} htmlFor={`${blockId}-${current.key}`} className="mt-4">
        <Textarea
          id={`${blockId}-${current.key}`}
          value={merged[current.key]}
          onChange={(e) => onChange({ ...merged, [current.key]: e.target.value })}
          disabled={disabled}
          rows={5}
        />
      </Field>

      <div className="mt-8 flex items-center justify-between gap-4">
        <Button
          type="button"
          variant="quiet"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          Back
        </Button>
        {!isLast && (
          <Button type="button" size="lg" onClick={() => setStep((s) => s + 1)}>
            Next
          </Button>
        )}
      </div>

      {isLast && merged.stronger.trim() !== '' && (
        <p className="mt-10 border-l-2 border-gilt pl-5 font-display text-xl leading-snug">
          And then it happens again, and you think: I knew this would happen.
        </p>
      )}

      <p className="mt-8 text-2xs text-ink-muted">Only you can read this.</p>
      <CrisisResources className="mt-10" />
    </div>
  )
}

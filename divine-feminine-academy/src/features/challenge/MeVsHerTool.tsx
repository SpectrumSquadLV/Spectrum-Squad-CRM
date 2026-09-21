'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Button, Field, Textarea } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import { recordToolRun, type ToolState } from './tool-actions'

/**
 * ME VS. HER, outside the seven days.
 *
 * Under two minutes, and it reuses Day 7's shape exactly: the same four
 * questions in the same order, ME before HER, both answers side by side, and
 * then a choice with neither button favoured.
 *
 * The same rules apply as on Day 7, and they are the reason this is a
 * separate component rather than a shortened lesson: the system never
 * suggests what HER would do, ME is never shamed, and choosing ME is allowed.
 * A tool that nudged her toward HER would be a tool she stops trusting on
 * exactly the day she needs it.
 */
type Step =
  | 'intro'
  | 'decision'
  | 'why'
  | 'me'
  | 'her'
  | 'compare'
  | 'choose'
  | 'done'

const initial: ToolState = {}

export function MeVsHerTool({ choiceCount }: { choiceCount: number }) {
  const [step, setStep] = useState<Step>('intro')
  const [decision, setDecision] = useState('')
  const [why, setWhy] = useState('')
  const [meWould, setMeWould] = useState('')
  const [herWould, setHerWould] = useState('')
  const [herWhy, setHerWhy] = useState('')
  const [chosen, setChosen] = useState<'me' | 'her' | null>(null)

  const [state, submit, pending] = useActionState(recordToolRun, initial)

  if (state.ok || step === 'done') {
    return (
      <div className="measure py-10">
        <p className="font-display text-2xl leading-snug">
          {chosen === 'her' ? 'You chose HER.' : 'You chose consciously.'}
        </p>
        <p className="mt-5 text-ink-soft">
          {chosen === 'her'
            ? 'That is the whole practice. Nothing else is required.'
            : 'You paused, you looked at both, and you decided. That is the practice working, whichever way it went.'}
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/my-academy">Back to my academy</Link>
          </Button>
          <Button variant="secondary" asChild>
            <Link href="/my-academy/her">See what you have chosen</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="py-6">
      {step === 'intro' && (
        <div className="measure">
          <h1 className="font-display text-3xl tracking-tight">ME VS. HER</h1>
          <div className="mt-8 space-y-5 text-ink-soft">
            <p>You&rsquo;re standing at a choice point.</p>
            <p>You don&rsquo;t need to silence ME to choose HER.</p>
            <p>
              Bring the decision here.
              <br />
              Let&rsquo;s see what each of them would do.
            </p>
          </div>
          <Button size="lg" className="mt-10" onClick={() => setStep('decision')}>
            START
          </Button>
          {choiceCount > 0 && (
            <p className="mt-6 text-2xs text-ink-muted">
              You&rsquo;ve chosen HER {choiceCount} time
              {choiceCount === 1 ? '' : 's'}.
            </p>
          )}
        </div>
      )}

      {step === 'decision' && (
        <Ask
          prompt="What are you deciding?"
          value={decision}
          onChange={setDecision}
          onNext={() => setStep('why')}
          canAdvance={decision.trim() !== ''}
        />
      )}

      {step === 'why' && (
        <Ask
          prompt="WHY AM I DOING THIS?"
          helper="Not the answer that sounds good. What is actually underneath it?"
          earlier={decision}
          earlierLabel="You're deciding"
          value={why}
          onChange={setWhy}
          onNext={() => setStep('me')}
          canAdvance
        />
      )}

      {step === 'me' && (
        <Ask
          prompt="WHAT DOES ME WANT TO DO?"
          helper="Let ME answer first. Don't judge her."
          earlier={decision}
          earlierLabel="You're deciding"
          value={meWould}
          onChange={setMeWould}
          onNext={() => setStep('her')}
          canAdvance={meWould.trim() !== ''}
        />
      )}

      {step === 'her' && (
        <div className="measure">
          <Earlier label="You're deciding" text={decision} />
          <h2 className="mt-8 text-2xl">WHAT WOULD HER DO?</h2>
          <p className="mt-3 text-sm text-ink-muted">
            If you knew you were worthy of everything you desire.
          </p>
          <Field label="HER would" htmlFor="her-would" className="mt-6">
            <Textarea
              id="her-would"
              rows={5}
              value={herWould}
              onChange={(e) => setHerWould(e.target.value)}
            />
          </Field>
          <Field label="Why would HER make that choice?" htmlFor="her-why" className="mt-6">
            <Textarea
              id="her-why"
              rows={4}
              value={herWhy}
              onChange={(e) => setHerWhy(e.target.value)}
            />
          </Field>
          <Button
            size="lg"
            className="mt-8"
            disabled={herWould.trim() === ''}
            onClick={() => setStep('compare')}
          >
            Continue
          </Button>
        </div>
      )}

      {step === 'compare' && (
        <div className="measure">
          <Earlier label="You're deciding" text={decision} />
          <div className="mt-8 grid items-stretch gap-5 md:grid-cols-[1fr_auto_1fr]">
            <section className="rounded-xl border border-rule bg-alabaster p-6">
              <h3 className="font-display text-2xl tracking-tight">ME</h3>
              <p className="mt-4 whitespace-pre-line text-lg leading-relaxed">
                {meWould}
              </p>
              {why && (
                <p className="mt-5 whitespace-pre-line text-sm text-ink-muted">
                  {why}
                </p>
              )}
            </section>
            <div
              aria-hidden
              className="flex items-center justify-center py-2 font-display text-sm tracking-[0.3em] text-clay-deep"
            >
              VS.
            </div>
            <section className="rounded-xl border border-rule bg-alabaster p-6">
              <h3 className="font-display text-2xl tracking-tight">HER</h3>
              <p className="mt-4 whitespace-pre-line text-lg leading-relaxed">
                {herWould}
              </p>
              {herWhy && (
                <p className="mt-5 whitespace-pre-line text-sm text-ink-muted">
                  {herWhy}
                </p>
              )}
            </section>
          </div>
          <Button size="lg" className="mt-10" onClick={() => setStep('choose')}>
            Continue
          </Button>
        </div>
      )}

      {step === 'choose' && (
        <form action={submit} className="measure">
          <h2 className="font-display text-3xl tracking-tight">
            WHO ARE YOU CHOOSING?
          </h2>

          <input type="hidden" name="decision" value={decision} />
          <input type="hidden" name="meWould" value={meWould} />
          <input type="hidden" name="herWould" value={herWould} />
          <input type="hidden" name="herWhy" value={herWhy} />
          <input type="hidden" name="chosen" value={chosen ?? ''} />

          {/* Equal buttons. Neither is styled as the right answer. */}
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {(['me', 'her'] as const).map((who) => (
              <Button
                key={who}
                type="button"
                variant="secondary"
                size="lg"
                aria-pressed={chosen === who}
                onClick={() => setChosen(who)}
                className={cn(
                  'w-full justify-center font-display text-2xl tracking-tight',
                  chosen === who && 'border-clay bg-linen text-ink',
                )}
              >
                {who === 'me' ? 'ME' : 'HER'}
              </Button>
            ))}
          </div>

          {chosen === 'me' && (
            <p className="mt-8 text-ink-soft">
              That&rsquo;s okay. This was never about pretending ME
              doesn&rsquo;t exist.
            </p>
          )}

          {state.error && (
            <p className="mt-6 text-sm text-caution">{state.error}</p>
          )}

          <Button
            type="submit"
            size="lg"
            className="mt-10"
            disabled={!chosen || pending}
          >
            {pending ? 'Saving…' : 'Finish'}
          </Button>
        </form>
      )}
    </div>
  )
}

function Earlier({ label, text }: { label: string; text: string }) {
  if (!text) return null
  return (
    <div className="border-l-2 border-gilt pl-5">
      <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">{label}</p>
      <p className="mt-2 whitespace-pre-line font-display text-lg leading-snug">
        {text}
      </p>
    </div>
  )
}

function Ask({
  prompt,
  helper,
  earlier,
  earlierLabel,
  value,
  onChange,
  onNext,
  canAdvance,
}: {
  prompt: string
  helper?: string
  earlier?: string
  earlierLabel?: string
  value: string
  onChange: (v: string) => void
  onNext: () => void
  canAdvance: boolean
}) {
  return (
    <div className="measure">
      {earlier && <Earlier label={earlierLabel ?? ''} text={earlier} />}
      <h2 className={cn('text-2xl', earlier && 'mt-8')}>{prompt}</h2>
      {helper && <p className="mt-3 text-sm text-ink-muted">{helper}</p>}
      <Field label="Your words" htmlFor="tool-answer" className="mt-6">
        <Textarea
          id="tool-answer"
          rows={5}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
      <Button size="lg" className="mt-8" disabled={!canAdvance} onClick={onNext}>
        Continue
      </Button>
    </div>
  )
}

'use client'

import { Button, Field, Input } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

const empty: Response = { action: '', when: '', done: false }

export function ActionCommitmentMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
  today,
}: BlockMemberProps<Config, Response>) {
  const current = value ?? empty
  const set = (patch: Partial<Response>) => onChange({ ...current, ...patch })

  /*
   * The echoed shape: she wrote it one screen ago, and this is the moment she
   * commits to it. Her own sentence, set large, and one button.
   */
  if (config.echoesFrom) {
    const echoed = (today?.[config.echoesFrom] ?? '').trim()
    const committed = Boolean(current.confirmedAt)

    return (
      <div className="measure">
        <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
          {config.prompt}
        </p>

        {echoed ? (
          <p className="mt-6 whitespace-pre-line font-display text-2xl leading-snug text-ink md:text-3xl">
            {echoed}
          </p>
        ) : (
          <p className="mt-6 text-sm text-ink-muted">
            Write your choice on the screen before this one first.
          </p>
        )}

        {echoed && (
          <div className="mt-10">
            <Button
              type="button"
              size="lg"
              disabled={disabled}
              onClick={() =>
                onChange({
                  action: echoed,
                  when: '',
                  done: true,
                  confirmedAt: current.confirmedAt ?? new Date().toISOString(),
                })
              }
            >
              {config.confirmLabel}
            </Button>
            {committed && (
              <p className="mt-4 text-2xs text-ink-muted">
                That is enough. Nothing to prove and nothing to upload.
              </p>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-8">{config.helper}</p>}

      {config.suggestions.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {config.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={disabled}
              onClick={() => set({ action: s })}
              className={cn(
                'min-h-11 rounded-md border px-4 text-xs transition-colors',
                current.action === s
                  ? 'border-plum bg-plum-wash text-plum'
                  : 'border-rule-strong bg-alabaster text-ink-soft hover:border-clay',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-6">
        <Field label="What you will do" htmlFor={`${blockId}-action`}>
          <Input
            value={current.action}
            onChange={(e) => set({ action: e.target.value })}
            disabled={disabled}
          />
        </Field>

        <Field label="When" htmlFor={`${blockId}-when`} hint="Today, tonight, Thursday.">
          <Input
            value={current.when}
            onChange={(e) => set({ when: e.target.value })}
            disabled={disabled}
          />
        </Field>

        <label className="flex min-h-12 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={current.done}
            disabled={disabled}
            onChange={(e) => set({ done: e.target.checked })}
            className="size-4 accent-[var(--color-plum)]"
          />
          I did it
        </label>
      </div>
    </div>
  )
}

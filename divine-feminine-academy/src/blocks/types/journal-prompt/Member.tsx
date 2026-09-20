'use client'

import { Field, Input, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

export function JournalPromptMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const current: Response = value ?? { text: '' }

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-6">{config.helper}</p>}

      <div className="flex flex-col gap-6">
        <Field label="Give it a name (optional)" htmlFor={`${blockId}-title`}>
          <Input
            value={current.title ?? ''}
            onChange={(e) => onChange({ ...current, title: e.target.value })}
            disabled={disabled}
          />
        </Field>

        <Field label="Your words" htmlFor={`${blockId}-text`}>
          <Textarea
            value={current.text}
            placeholder={config.placeholder}
            onChange={(e) => onChange({ ...current, text: e.target.value })}
            disabled={disabled}
            rows={12}
          />
        </Field>
      </div>

      <p className="mt-3 text-2xs text-ink-muted">
        Encrypted. Nobody who works here can read this.
      </p>

      <CrisisResources className="mt-8" />
    </div>
  )
}

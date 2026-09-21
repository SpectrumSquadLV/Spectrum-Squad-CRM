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
}: BlockMemberProps<Config, Response>) {
  const text = value?.text ?? ''
  const words = text.trim() ? text.trim().split(/\s+/).length : 0

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-6">{config.helper}</p>}

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
    </div>
  )
}

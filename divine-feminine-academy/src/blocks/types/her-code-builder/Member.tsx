'use client'

import { Field, Input, Textarea } from '@/design-system/primitives'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

export function HerCodeBuilderMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const current: Response = value ?? {
    lines: Array.from({ length: config.lineCount }, () => ''),
    declaration: '',
  }

  const setLine = (index: number, text: string) => {
    const lines = [...current.lines]
    lines[index] = text
    onChange({ ...current, lines })
  }

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-8">{config.helper}</p>}

      <ol className="flex flex-col gap-5">
        {current.lines.map((line, i) => (
          <li key={i}>
            <Field label={`Line ${i + 1}`} htmlFor={`${blockId}-line-${i}`}>
              <Input
                value={line}
                placeholder={config.linePlaceholder}
                onChange={(e) => setLine(i, e.target.value)}
                disabled={disabled}
                className="font-display text-lg"
              />
            </Field>
          </li>
        ))}
      </ol>

      <Field
        label="And the one sentence you are living by now"
        htmlFor={`${blockId}-declaration`}
        className="mt-8"
      >
        <Textarea
          value={current.declaration}
          onChange={(e) => onChange({ ...current, declaration: e.target.value })}
          disabled={disabled}
          rows={3}
          className="border-plum/30 focus:border-plum font-display text-lg"
        />
      </Field>
    </div>
  )
}

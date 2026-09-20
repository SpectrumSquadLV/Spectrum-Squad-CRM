'use client'

import { Button, Field, Rule, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import type { BlockMemberProps } from '../../contract'
import type { AuditRow, Config, Response } from './schema'

const blankRow: AuditRow = { whose: '', what: '', ifTheyDisapproved: '' }

export function ValidationAuditMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const current: Response = value ?? {
    rows: Array.from({ length: config.minEntries }, () => ({ ...blankRow })),
    realisation: '',
  }

  const setRow = (index: number, patch: Partial<AuditRow>) => {
    const rows = current.rows.map((row, i) =>
      i === index ? { ...row, ...patch } : row,
    )
    onChange({ ...current, rows })
  }

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-8">{config.helper}</p>}

      <ol className="flex flex-col gap-10">
        {current.rows.map((row, i) => (
          <li key={i}>
            <p className="text-2xs uppercase tracking-[0.18em] text-clay-deep">
              {i + 1}
            </p>
            <div className="mt-4 flex flex-col gap-5">
              <Field label="Whose approval" htmlFor={`${blockId}-whose-${i}`}>
                <Textarea
                  value={row.whose}
                  onChange={(e) => setRow(i, { whose: e.target.value })}
                  disabled={disabled}
                  rows={2}
                />
              </Field>
              <Field label="What you do for it" htmlFor={`${blockId}-what-${i}`}>
                <Textarea
                  value={row.what}
                  onChange={(e) => setRow(i, { what: e.target.value })}
                  disabled={disabled}
                  rows={3}
                />
              </Field>
              <Field
                label="What would actually happen if they disapproved"
                htmlFor={`${blockId}-if-${i}`}
              >
                <Textarea
                  value={row.ifTheyDisapproved}
                  onChange={(e) => setRow(i, { ifTheyDisapproved: e.target.value })}
                  disabled={disabled}
                  rows={3}
                />
              </Field>
            </div>
          </li>
        ))}
      </ol>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-8"
        disabled={disabled}
        onClick={() => onChange({ ...current, rows: [...current.rows, { ...blankRow }] })}
      >
        Add another
      </Button>

      <Rule tone="gilt" className="my-10" />

      <Field
        label="What you notice, reading that back"
        htmlFor={`${blockId}-realisation`}
      >
        <Textarea
          value={current.realisation}
          onChange={(e) => onChange({ ...current, realisation: e.target.value })}
          disabled={disabled}
          rows={5}
          className="border-plum/30 focus:border-plum"
        />
      </Field>

      <CrisisResources className="mt-10" />
    </div>
  )
}

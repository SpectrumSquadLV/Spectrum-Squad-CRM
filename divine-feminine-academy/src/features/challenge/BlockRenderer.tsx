'use client'

import { getBlock } from '@/blocks/registry'
import type { HerEvidence } from '@/blocks/contract'

/**
 * Renders one block by looking its type up in the registry.
 *
 * This is the whole reason a new programme needs no code: the day runner never
 * knows what kind of block it is showing.
 */
export function BlockRenderer({
  blockId,
  type,
  config,
  value,
  onChange,
  disabled,
  context,
}: {
  blockId: string
  type: string
  config: unknown
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
  context?: HerEvidence
}) {
  const definition = getBlock(type)

  if (!definition) {
    // An unknown type means content references a block this build does not
    // have. Say so plainly rather than rendering nothing and losing her work.
    return (
      <div className="measure rounded-md border border-dashed border-caution/50 bg-caution/5 p-5">
        <p className="text-xs text-caution">
          This part of the day could not be shown. Nothing you have written is
          lost — please let us know.
        </p>
      </div>
    )
  }

  const parsed = definition.configSchema.safeParse(config)
  if (!parsed.success) {
    return (
      <div className="measure rounded-md border border-dashed border-caution/50 bg-caution/5 p-5">
        <p className="text-xs text-caution">
          This exercise is not set up correctly yet.
        </p>
      </div>
    )
  }

  const Member = definition.Member

  return (
    <Member
      blockId={blockId}
      config={parsed.data}
      value={value}
      onChange={onChange}
      disabled={disabled}
      context={context}
    />
  )
}

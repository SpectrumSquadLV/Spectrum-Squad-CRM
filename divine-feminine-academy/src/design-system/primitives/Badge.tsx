import * as React from 'react'
import { cn } from '@/lib/utils/cn'

export type Area = 'self' | 'love' | 'life' | 'wealth'

/** Area marks are thin and small. Never a filled card. */
const areaTone: Record<Area, string> = {
  self: 'text-area-self border-area-self/40 bg-area-self/5',
  love: 'text-area-love border-area-love/40 bg-area-love/5',
  life: 'text-area-life border-area-life/40 bg-area-life/5',
  wealth: 'text-area-wealth border-area-wealth/40 bg-area-wealth/5',
}

export function Badge({
  className,
  area,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { area?: Area }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-2 py-0.5',
        'text-2xs font-medium uppercase tracking-wider',
        area ? areaTone[area] : 'text-ink-muted border-rule-strong bg-transparent',
        className,
      )}
      {...props}
    />
  )
}

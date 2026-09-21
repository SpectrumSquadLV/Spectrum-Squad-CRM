import * as React from 'react'
import { cn } from '@/lib/utils/cn'

export type Area = 'herself' | 'relationships' | 'success' | 'money'

/** Area marks are thin and small. Never a filled card. */
const areaTone: Record<Area, string> = {
  herself: 'text-area-herself border-area-herself/40 bg-area-herself/5',
  relationships:
    'text-area-relationships border-area-relationships/40 bg-area-relationships/5',
  money: 'text-area-money border-area-money/40 bg-area-money/5',
  success: 'text-area-success border-area-success/40 bg-area-success/5',
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

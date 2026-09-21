import { cn } from '@/lib/utils/cn'

/**
 * A hairline. The `gilt` tone is the ONLY sanctioned use of gold:
 * a 1px line or a small mark, never a fill.
 */
export function Rule({
  className,
  tone = 'default',
}: {
  className?: string
  tone?: 'default' | 'strong' | 'gilt'
}) {
  return (
    <hr
      className={cn(
        'border-0 border-t',
        tone === 'default' && 'border-rule',
        tone === 'strong' && 'border-rule-strong',
        tone === 'gilt' && 'border-gilt/50',
        className,
      )}
    />
  )
}

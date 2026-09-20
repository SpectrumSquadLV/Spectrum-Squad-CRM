import { cn } from '@/lib/utils/cn'

/**
 * Marks copy or data that is NOT real yet.
 *
 * Every invented testimonial, statistic or bio on this site must sit inside
 * one of these. It is deliberately visible: placeholder content that looks
 * finished is how fake social proof ships by accident.
 *
 * Search the codebase for `<Placeholder` before launch. The list should be
 * empty.
 */
export function Placeholder({
  label = 'Placeholder',
  note,
  children,
  className,
}: {
  label?: string
  note?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-placeholder
      className={cn(
        'relative rounded-md border border-dashed border-caution/50 bg-caution/5 p-5',
        className,
      )}
    >
      <p className="mb-3 text-2xs font-medium uppercase tracking-[0.16em] text-caution">
        {label}
        {note ? <span className="font-normal normal-case tracking-normal"> — {note}</span> : null}
      </p>
      {children}
    </div>
  )
}

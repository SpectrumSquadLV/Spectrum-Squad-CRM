import * as React from 'react'
import { cn } from '@/lib/utils/cn'

/** A page section with the editorial vertical rhythm and a max width. */
export function Section({
  className,
  width = 'default',
  ...props
}: React.HTMLAttributes<HTMLElement> & { width?: 'default' | 'wide' | 'full' }) {
  return (
    <section
      className={cn(
        'section-y mx-auto px-5 md:px-8',
        width === 'default' && 'max-w-4xl',
        width === 'wide' && 'max-w-6xl',
        width === 'full' && 'max-w-none',
        className,
      )}
      {...props}
    />
  )
}

/** The small caps label that sits above a heading. */
export function Eyebrow({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'text-2xs uppercase tracking-[0.22em] text-clay-deep',
        className,
      )}
      {...props}
    />
  )
}

/** Body copy at the editorial measure. */
export function Prose({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'measure text-ink-soft [&>p]:mb-5 [&>p:last-child]:mb-0',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A pull quote.
 *
 * NOT for testimonials - real words from real women go through the
 * testimonials table, which has an is_placeholder flag for exactly this
 * reason. This is for quoting the philosophy.
 */
export function PullQuote({
  className,
  ...props
}: React.HTMLAttributes<HTMLQuoteElement>) {
  return (
    <blockquote
      className={cn(
        'measure border-l border-gilt/50 pl-6 font-display text-xl leading-snug text-plum',
        className,
      )}
      {...props}
    />
  )
}

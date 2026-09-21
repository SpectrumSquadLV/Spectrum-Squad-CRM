import * as React from 'react'
import { cn } from '@/lib/utils/cn'

export function Card({
  className,
  tone = 'raised',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { tone?: 'raised' | 'flat' | 'sunken' }) {
  return (
    <div
      className={cn(
        'rounded-lg p-6 md:p-8',
        tone === 'raised' && 'bg-alabaster border border-rule shadow-raised',
        tone === 'flat' && 'bg-transparent border border-rule',
        tone === 'sunken' && 'bg-linen',
        className,
      )}
      {...props}
    />
  )
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-xl', className)} {...props} />
}

export function CardBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-3 text-ink-soft measure', className)} {...props} />
}

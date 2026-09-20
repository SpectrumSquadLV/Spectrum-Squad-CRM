'use client'

import * as LabelPrimitive from '@radix-ui/react-label'
import * as React from 'react'
import { cn } from '@/lib/utils/cn'

const control = cn(
  'w-full rounded-md bg-alabaster border border-rule-strong',
  'px-4 py-3 text-sm text-ink placeholder:text-ink-faint',
  'transition-colors duration-[--duration-quick] ease-[--ease-out-soft]',
  'hover:border-clay/60 focus:border-clay focus:outline-none',
  'disabled:opacity-50 disabled:bg-linen',
  'aria-[invalid=true]:border-critical',
)

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, 'min-h-12', className)} {...props} />
})

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(control, 'min-h-36 leading-relaxed resize-y', className)}
      {...props}
    />
  )
})

export function Label({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('block text-xs font-medium text-ink-soft', className)}
      {...props}
    />
  )
}

/**
 * A labelled control with optional hint and error.
 * Errors are wired to the control with aria-describedby so screen readers
 * announce them - the reason this wrapper exists at all.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string
  hint?: string
  error?: string
  htmlFor: string
  children: React.ReactNode
  className?: string
}) {
  const hintId = hint ? `${htmlFor}-hint` : undefined
  const errorId = error ? `${htmlFor}-error` : undefined

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {hint && (
        <p id={hintId} className="text-2xs text-ink-muted">
          {hint}
        </p>
      )}
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id: htmlFor,
            'aria-describedby': [hintId, errorId].filter(Boolean).join(' ') || undefined,
            'aria-invalid': error ? true : undefined,
          })
        : children}
      {error && (
        <p id={errorId} role="alert" className="text-2xs text-critical">
          {error}
        </p>
      )}
    </div>
  )
}

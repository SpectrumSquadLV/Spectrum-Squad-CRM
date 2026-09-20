import { Slot } from '@radix-ui/react-slot'
import * as React from 'react'
import { cn } from '@/lib/utils/cn'

type Variant = 'primary' | 'secondary' | 'quiet' | 'link'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary:
    'bg-plum text-bone hover:bg-plum-deep active:bg-plum-deep shadow-raised',
  secondary:
    'bg-alabaster text-ink border border-rule-strong hover:border-clay hover:text-clay-deep',
  quiet: 'bg-transparent text-ink-soft hover:bg-linen hover:text-ink',
  link: 'bg-transparent text-clay-deep underline underline-offset-4 decoration-clay/40 hover:decoration-clay-deep px-0',
}

const sizes: Record<Size, string> = {
  // Every target clears 44px. She is on a phone, often one-handed.
  sm: 'min-h-11 px-4 text-xs gap-2',
  md: 'min-h-12 px-6 text-sm gap-2',
  lg: 'min-h-14 px-8 text-base gap-3',
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /** Render as the child element (e.g. a Next.js <Link>) instead of a <button>. */
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant = 'primary', size = 'md', asChild, ...props },
    ref,
  ) {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center rounded-md font-sans font-medium',
          'transition-colors duration-[--duration-quick] ease-[--ease-out-soft]',
          'disabled:pointer-events-none disabled:opacity-40',
          variants[variant],
          sizes[size],
          className,
        )}
        {...props}
      />
    )
  },
)

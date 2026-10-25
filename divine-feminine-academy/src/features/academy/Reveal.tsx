import { cn } from '@/lib/utils/cn'

/**
 * The space arriving, rather than appearing.
 *
 * One effect, used sparingly: a few pixels of rise and a fade, staggered so
 * the page settles in the order it should be read. That is the entire motion
 * vocabulary here - nothing bounces, nothing scales, nothing sparkles.
 *
 * The restraint is not timidity. Motion on a page like this is doing one job:
 * making the space feel like it was already there and is now being noticed.
 * Anything that draws attention to ITSELF does the opposite - it says a
 * developer added an animation - and a member's home she opens every morning
 * has to survive the two hundredth viewing, which rules out anything she
 * would ever wait through.
 *
 * Implemented in CSS rather than a library. A fade and eight pixels does not
 * justify shipping an animation runtime to every woman's phone.
 *
 * `prefers-reduced-motion` is honoured in globals.css, where the animation
 * collapses to nothing and the content is simply THERE. That is not a
 * degraded version; for a woman who gets motion sick it is the correct one.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode
  /** Steps of 90ms. Kept small: a long stagger reads as a slow page. */
  delay?: number
  className?: string
}) {
  return (
    <div
      className={cn('df-reveal', className)}
      style={{ animationDelay: `${delay * 90}ms` }}
    >
      {children}
    </div>
  )
}

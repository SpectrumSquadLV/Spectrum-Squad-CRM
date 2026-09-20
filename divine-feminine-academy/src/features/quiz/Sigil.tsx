import { cn } from '@/lib/utils/cn'
import type { ProtectiveMode } from './archetypes'

/**
 * THE FOUR PROTECTOR SIGILS.
 *
 * Four marks from one system, not four illustrations. What holds them
 * together is deliberate and worth keeping if these are ever edited:
 *
 *   ONE VESSEL. A 44-unit circle in a 120 box, in every one. Three of the
 *   four close it; only the Escape Artist breaks it open, and that break is
 *   the whole point of her.
 *
 *   TWO WEIGHTS. 1.5 for the vessel, 2 for what is inside it. The circle
 *   always sits back and her own geometry always comes forward.
 *
 *   ONE WARM MARK. A single gilt dot each, and only one - at the guard, past
 *   the opening, at the centre, above the surface. It is the only colour in
 *   the system, so it carries the eye to the point of each symbol.
 *
 *   STROKE ONLY. No fills beyond that dot, which is what lets these be
 *   embossed, foiled, engraved or stitched later without being redrawn.
 *
 * THE REDUCED FORM IS A DIFFERENT DRAWING, not the full one scaled down.
 * Below about 24px the thin vessel disappears and the closely-spaced interior
 * lines close into mud - the Quiet Storm's second wave goes first. So `mark`
 * thickens every stroke and removes whatever cannot survive. A real maker's
 * mark has always had two cuts; this is the same problem.
 */

export type SigilVariant = 'full' | 'mark'

const ink = 'currentColor'
const gilt = 'var(--color-gilt, #b2914f)'

function Commander({ variant }: { variant: SigilVariant }) {
  if (variant === 'mark') {
    return (
      <>
        <circle cx="60" cy="60" r="44" fill="none" stroke={ink} strokeWidth="2.5" />
        <path d="M60 30 L60 92" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" />
        <path d="M44 52 L60 30 L76 52" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M40 66 L80 66" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" />
      </>
    )
  }
  return (
    <>
      <circle cx="60" cy="60" r="44" fill="none" stroke={ink} strokeWidth="1.5" />
      <path d="M60 26 L60 96" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <path d="M42 50 L60 26 L78 50" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M38 66 L82 66" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="66" r="3" fill={gilt} />
    </>
  )
}

function EscapeArtist({ variant }: { variant: SigilVariant }) {
  if (variant === 'mark') {
    return (
      <>
        <path d="M92 38 A44 44 0 1 0 92 82" fill="none" stroke={ink} strokeWidth="2.5" strokeLinecap="round" />
        <path d="M36 60 L106 60" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" />
        <path d="M44 42 L94 42" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" />
        <path d="M44 78 L94 78" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" />
      </>
    )
  }
  return (
    <>
      <path d="M92 38 A44 44 0 1 0 92 82" fill="none" stroke={ink} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M40 48 L98 48" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <path d="M34 60 L108 60" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <path d="M40 72 L98 72" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <circle cx="108" cy="60" r="3" fill={gilt} />
    </>
  )
}

function Watcher({ variant }: { variant: SigilVariant }) {
  if (variant === 'mark') {
    return (
      <>
        <circle cx="60" cy="60" r="44" fill="none" stroke={ink} strokeWidth="2.5" />
        <circle cx="60" cy="60" r="18" fill="none" stroke={ink} strokeWidth="3" />
        <path d="M16 60 L40 60" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" />
        <path d="M80 60 L104 60" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" />
      </>
    )
  }
  return (
    <>
      <circle cx="60" cy="60" r="44" fill="none" stroke={ink} strokeWidth="1.5" />
      <circle cx="60" cy="60" r="18" fill="none" stroke={ink} strokeWidth="2" />
      <path d="M16 60 L42 60" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <path d="M78 60 L104 60" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="60" r="3" fill={gilt} />
    </>
  )
}

function QuietStorm({ variant }: { variant: SigilVariant }) {
  if (variant === 'mark') {
    // One wave, not three. At this size the second closes into the first.
    return (
      <>
        <circle cx="60" cy="60" r="44" fill="none" stroke={ink} strokeWidth="2.5" />
        <path d="M18 56 L102 56" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" />
        <path d="M26 76 Q42 64 58 76 T92 74" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" />
      </>
    )
  }
  return (
    <>
      <circle cx="60" cy="60" r="44" fill="none" stroke={ink} strokeWidth="1.5" />
      <path d="M18 58 L102 58" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <path d="M24 72 Q38 62 52 72 T80 72 T104 70" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <path d="M30 86 Q44 76 58 86 T86 86" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="44" r="3" fill={gilt} />
    </>
  )
}

const shapes: Record<
  ProtectiveMode,
  (props: { variant: SigilVariant }) => React.JSX.Element
> = {
  fight: Commander,
  flight: EscapeArtist,
  freeze: Watcher,
  sulk: QuietStorm,
}

/** What a screen reader gets. The symbol, described, not the archetype name. */
const described: Record<ProtectiveMode, string> = {
  fight:
    'A closed circle holding an upward blade on a single axis, crossed by a guard.',
  flight:
    'A circle broken open on one side, with three lines of movement leaving through the gap.',
  freeze:
    'Two concentric circles, divided by a single horizontal threshold.',
  sulk: 'A circle with a flat surface across it, and waves moving underneath.',
}

export function Sigil({
  mode,
  variant = 'full',
  className,
  /** Draws itself on first paint. Only ever on the reveal. */
  animate = false,
  title,
}: {
  mode: ProtectiveMode
  variant?: SigilVariant
  className?: string
  animate?: boolean
  /** Overrides the description, or pass null to hide it from the tree. */
  title?: string | null
}) {
  const Shape = shapes[mode]
  const label = title === undefined ? described[mode] : title

  return (
    <svg
      viewBox="0 0 120 120"
      className={cn('block', animate && 'sigil-draw', className)}
      role={label ? 'img' : 'presentation'}
      {...(label ? { 'aria-label': label } : { 'aria-hidden': true })}
    >
      <Shape variant={variant} />
    </svg>
  )
}

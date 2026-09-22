import { cn } from '@/lib/utils/cn'

/**
 * The one signature mark of Divine Feminine.
 *
 * The idea underneath the whole platform is that nothing is being made: what
 * she wants already exists, and the work is letting it become visible. So the
 * mark is an APERTURE - two fine arcs that do not quite meet, with light
 * between them. Something is behind it. The opening is what lets it through.
 *
 * It is drawn rather than illustrated, in gilt hairlines, which is the only
 * thing the palette allows gilt to be used for. That constraint is doing real
 * work here: a mark that can only ever be a hairline cannot drift into a logo,
 * a badge, or a sparkle.
 *
 * What it deliberately is NOT: a moon, an eye, a mandala, a crystal, a
 * lotus. Those read as astrology app within about a second, and this has to
 * read as a fashion house. The vesica is a piece of geometry, not a symbol
 * anyone has to decode, and it means nothing until the page around it gives
 * it a meaning.
 *
 * `open` widens the gap. Passed on hover from the entry it sits in, so the
 * aperture opens as she moves toward the thing rather than on a timer - the
 * metaphor is only worth having if she is the one causing it.
 */
export function Aperture({
  className,
  open = false,
  size = 40,
}: {
  className?: string
  open?: boolean
  size?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
    >
      <defs>
        {/*
          The light behind the opening. Brightest along the centre line and
          gone by the edges, so it reads as something coming THROUGH rather
          than a shape that happens to be lit.
        */}
        <radialGradient id="df-aperture-light" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--color-gilt)" stopOpacity="0.42" />
          <stop offset="55%" stopColor="var(--color-gilt)" stopOpacity="0.10" />
          <stop offset="100%" stopColor="var(--color-gilt)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse
        cx="20"
        cy="20"
        rx={open ? 9.5 : 6.5}
        ry="13"
        fill="url(#df-aperture-light)"
        className="transition-all duration-700 ease-out motion-reduce:transition-none"
      />

      {/*
        Two arcs, mirrored. They meet at top and bottom and bow apart in the
        middle; `open` bows them further. Vector-effect keeps the hairline a
        hairline at any size - without it, scaling the mark up thickens the
        stroke and it stops being a hairline, which is the one thing it must
        always be.
      */}
      {[1, -1].map((dir) => (
        <path
          key={dir}
          d={`M20 5 C ${20 + dir * (open ? 13 : 9)} 11, ${20 + dir * (open ? 13 : 9)} 29, 20 35`}
          stroke="var(--color-gilt)"
          strokeOpacity="0.85"
          strokeWidth="1.15"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          className="transition-all duration-700 ease-out motion-reduce:transition-none"
        />
      ))}
    </svg>
  )
}

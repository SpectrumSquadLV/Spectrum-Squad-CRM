import Link from 'next/link'
import { cn } from '@/lib/utils/cn'
import { Aperture } from './Aperture'
import type { Room } from './rooms'

/**
 * One room, at the weight it has earned.
 *
 * Four equal boxes in a grid is the exact thing the brief rules out, and it
 * is also just wrong: the room she can walk into today and the room that does
 * not exist yet are not equivalent, and making them look equivalent forces
 * her to read all four carefully to find that out. Scale does the work
 * instead - the open one is large and dark, the waiting ones are quiet - so
 * she can tell what is available before she has read a word.
 */
export function RoomCard({
  room,
  href,
  standing,
}: {
  room: Room
  /** Resolved per woman; absent means closed. */
  href?: string
  /** One true line about her own state in this room, or nothing. */
  standing?: string | null
}) {
  const feature = room.scale === 'feature'
  const quiet = room.scale === 'quiet'

  const body = (
    <>
      <div className="flex items-start justify-between gap-6">
        <h3
          className={cn(
            'font-display leading-[1.05]',
            feature ? 'text-3xl md:text-4xl' : quiet ? 'text-xl' : 'text-2xl',
            feature && 'text-bone',
          )}
        >
          {room.title}
        </h3>
        {feature && <Aperture open size={38} className="mt-1 shrink-0" />}
      </div>

      <p
        className={cn(
          'measure mt-4 leading-relaxed',
          feature ? 'text-base text-bone/75' : 'text-sm text-ink-soft',
        )}
      >
        {room.line}
      </p>

      {standing && (
        <p
          className={cn(
            'mt-4 text-2xs uppercase tracking-[0.18em]',
            feature ? 'text-bone/60' : 'text-clay-deep',
          )}
        >
          {standing}
        </p>
      )}

      {href ? (
        <p
          className={cn(
            'mt-8 inline-flex items-center gap-2 text-2xs uppercase tracking-[0.22em]',
            feature ? 'text-bone' : 'text-clay-deep',
          )}
        >
          Enter
          <span
            aria-hidden
            className="transition-transform duration-500 ease-out group-hover:translate-x-1 motion-reduce:transition-none"
          >
            &rarr;
          </span>
        </p>
      ) : (
        /*
         * Closed, and saying so.
         *
         * Not "coming soon" with a fake lock icon and a hover state. A plain
         * sentence that this room is being built. She paid to be here; she can
         * be told the truth about what is finished.
         */
        <p className="mt-8 text-2xs uppercase tracking-[0.22em] text-ink-faint">
          Not open yet
        </p>
      )}
    </>
  )

  const shell = cn(
    'block h-full',
    feature
      ? 'bg-plum-deep px-7 py-9 md:px-10 md:py-12'
      : quiet
        ? 'border border-rule px-6 py-7'
        : 'border border-rule-strong bg-alabaster px-6 py-8',
  )

  if (!href) {
    return <div className={cn(shell, 'opacity-80')}>{body}</div>
  }

  return (
    <Link
      href={href}
      className={cn(
        shell,
        'group rounded-sm outline-none transition-colors duration-500 focus-visible:ring-2 focus-visible:ring-plum focus-visible:ring-offset-4 focus-visible:ring-offset-bone motion-reduce:transition-none',
        !feature && 'hover:border-clay',
      )}
    >
      {body}
    </Link>
  )
}

/**
 * FOUR CARDS, FACE DOWN.
 *
 * The four archetypes shown without being named.
 *
 * Listing them by name here would do two bad things at once: it tells her the
 * answer before she has answered, which biases every question that follows,
 * and it spends the reveal the quiz exists to deliver. That rule predates
 * this component and it still holds.
 *
 * But the opposite - saying nothing - made the page a form. There was no
 * sense that anything was waiting at the end of it, and "90 seconds" is not a
 * reason to start something; the feeling that one of these is already yours
 * is.
 *
 * So: face down. She can see there are exactly four, that they are distinct,
 * and that one of them is hers. She cannot see which. That is the mechanic of
 * an oracle spread and it is the only honest way to show the four before she
 * has earned them.
 *
 * They do not move, they do not flip on hover, and they are not clickable.
 * A card that responds to a cursor invites her to pick one, and a woman who
 * picks her own archetype has not taken an assessment - she has chosen a
 * flattering answer, and the result stops being worth anything to her.
 *
 * THE MARKS ARE THE REAL ONES, from Sigil.tsx, in the `mark` variant it
 * already has for small sizes. This is the whole point: the card she sees
 * face down here is the card that turns over at her reveal, and the payoff
 * only exists if it is the same drawing. A second set of shapes invented for
 * this page would look fine and quietly make that false - which is exactly
 * what happened on the first pass of this component.
 *
 * They carry no accessible name. Each sigil can describe its own geometry,
 * but four geometric descriptions in a row tell a screen-reader user nothing
 * they can use and bury the caption that actually explains the spread.
 */

import { modes } from './archetypes'
import { Sigil } from './Sigil'

/** I, II, III, IV - set as ordinals, not quantities. */
const numerals = ['I', 'II', 'III', 'IV'] as const

export function OracleCards({ className }: { className?: string }) {
  return (
    <figure className={className}>
      <div className="flex justify-center gap-2 sm:gap-4">
        {modes.map((mode, i) => (
          <div
            key={mode}
            className={[
              'flex aspect-[2/3] w-full max-w-[9rem] flex-col items-center justify-between',
              'rounded-lg border border-plum-deep/40 bg-plum-deep px-2 py-4 sm:px-3 sm:py-6',
              'text-bone/70 shadow-sm',
            ].join(' ')}
          >
            <span className="font-display text-[0.65rem] tracking-[0.2em] sm:text-xs">
              {numerals[i]}
            </span>
            <Sigil
              mode={mode}
              variant="mark"
              title={null}
              className="h-8 w-8 sm:h-11 sm:w-11"
            />
            {/*
             * A hairline where a name would go. It says a name belongs here
             * and is not being shown, which is a different statement from an
             * empty space, and a more interesting one.
             */}
            <span aria-hidden="true" className="h-px w-6 bg-bone/30 sm:w-8" />
          </div>
        ))}
      </div>
      <figcaption className="mt-5 text-center text-sm text-ink-muted">
        Four of them. One has been running your life.
      </figcaption>
    </figure>
  )
}

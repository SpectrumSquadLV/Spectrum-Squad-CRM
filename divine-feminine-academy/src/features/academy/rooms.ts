/**
 * The rooms of the Academy.
 *
 * Divine Feminine Academy is the building. MY ACADEMY is her floor of it. The
 * rooms are what is on that floor, and ME VS. HER is one experience inside
 * ONE of them - which is the hierarchy the page has to make obvious in about
 * two seconds, because a woman who cannot tell the difference between the
 * challenge and the platform will think she has bought a seven-day thing and
 * leave when it ends.
 *
 * TWO OF THESE ROOMS ARE NOT BUILT YET, AND THEY SAY SO.
 *
 * Courses and the Library are real intentions with nothing behind them today.
 * They appear because the architecture is the point - she should be able to
 * see the shape of what she has joined - but a room that looks open and is
 * not is a small lie told to a paying customer, and it is the kind she will
 * remember. So an unbuilt room is named, described, and visibly closed: no
 * link, no hover, no pretending.
 *
 * `state` is computed per woman at render, not stored here: whether YOUR
 * ARCHETYPE is open depends on whether she has taken the quiz.
 */

export type RoomKey = 'challenges' | 'courses' | 'library' | 'archetype'

export interface Room {
  key: RoomKey
  title: string
  /** Quiana's words. One sentence, what the room is for. */
  line: string
  /**
   * Visual weight on the page. The rooms are deliberately not four equal
   * boxes: the one she can use now is large and dark, the ones that are
   * waiting are quieter, and the difference is doing the explaining.
   */
  scale: 'feature' | 'standard' | 'quiet'
  /** Present only when the room is open. */
  href?: string
  /** True when there is nothing behind it yet. */
  closed?: boolean
}

export const rooms: readonly Room[] = [
  {
    key: 'challenges',
    title: 'Challenges',
    line: 'Short, immersive transformations designed to move you from knowing to becoming.',
    scale: 'feature',
    href: '/my-academy/today',
  },
  {
    key: 'archetype',
    title: 'Your archetype',
    line: 'Revisit your archetype, understand your patterns, and see what you are being invited to transform next.',
    scale: 'standard',
    // href is decided per woman: her own result if she has one, the quiz if not.
  },
  {
    key: 'courses',
    title: 'Courses',
    line: 'Deeper experiences around identity, love, money, manifestation, relationships and success.',
    scale: 'quiet',
    closed: true,
  },
  {
    key: 'library',
    title: 'The Library',
    line: 'Practices, teachings, tools and resources to return to whenever you need them.',
    scale: 'quiet',
    closed: true,
  },
] as const

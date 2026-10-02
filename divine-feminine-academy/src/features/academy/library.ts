/**
 * THE LIBRARY.
 *
 * Divine Feminine is the place. ME VS. HER is the first thing inside it.
 *
 * That sentence is the whole reason this file exists. The member home used to
 * BE the challenge - it opened on "Day 3 is open" and the rest of the world
 * was two small cards underneath - which quietly said that the product is a
 * seven-day course and everything else is a feature of it. It is the other
 * way round, and it has to still be the other way round on the day there are
 * six experiences here instead of one.
 *
 * So an experience is DATA, not a hand-written section. Adding the second one
 * is an entry in this array and a row in the database. Nothing about the home
 * page is rewritten, and the first one does not become a special case.
 *
 * What is NOT here: placeholders. No greyed-out cards for work that does not
 * exist, no "coming soon", no invented titles. A library with one book on the
 * shelf and room around it reads as a library that is being built. A library
 * with one book and five empty frames reads as a shop with nothing in it.
 */

export interface LibraryEntry {
  /** Matches the program slug, so progress can be looked up. */
  slug: string
  title: string
  /** Sits above the title. Scale, not marketing: 'SEVEN DAYS'. */
  measure: string
  /**
   * One line. Drawn from the work itself, never written as a sales line.
   *
   * ME VS. HER's comes from what Day 1 actually does.
   */
  line: string
  /** Where ENTER goes when she has never opened it. */
  href: string
  kind: 'challenge' | 'course' | 'tool'
}

export const library: readonly LibraryEntry[] = [
  {
    slug: 'me-vs-her',
    title: 'ME VS. HER',
    measure: 'Seven days',
    line: 'The first woman you will meet here is you.',
    href: '/my-academy/me-vs-her',
    kind: 'challenge',
  },
] as const

/**
 * Roman numerals for the seven days.
 *
 * I to VII rather than a progress bar, and the difference is not decoration.
 * A bar fills, and a filling bar invites exactly one question: how far behind
 * am I. Seven marks answer a different question - which one is next - and say
 * nothing at all about speed. Numerals go further again: they read as
 * chapters in something, which is what they are.
 *
 * Seven is the whole range this needs, so it is a list rather than an
 * algorithm. A programme of a different length falls back to its own digits,
 * which is correct: XXIII is not elegant, it is just hard to read.
 */
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'] as const

export function numeral(day: number): string {
  return NUMERALS[day - 1] ?? String(day)
}

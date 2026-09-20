/**
 * THE PAIN AND THE POSSIBILITY.
 *
 * The longest section of the home page lives in this file, and right now it is
 * empty on purpose.
 *
 * Quiana's instruction was explicit and it is the most important one on the
 * project: the pain copy is NOT to be drafted here and NOT to be written by
 * her alone. It comes out of her the way ME VS HER did - she supplies the
 * psychology and the lived experience, it gets organised into copy without
 * being sanitised - and until that conversation happens, generic
 * self-development filler is strictly worse than nothing. A woman who reads a
 * line that could have come from any coach's website has already decided this
 * is another one of those.
 *
 * So the structure is built, the layout is designed for the exact shape those
 * lines take, and the arrays are empty. Fill one and that block appears on the
 * site. Fill none and the section is not rendered at all - a visitor sees a
 * page that reads as finished, and only an admin sees the note saying what is
 * still outstanding.
 *
 * WHAT THE LINES HAVE TO BE.
 *
 * Behaviours, not adjectives. The test Quiana set is a woman reading the LOVE
 * block and thinking "how the hell does she know I do that", and that comes
 * only from specificity - something she actually does, not a feeling she
 * might have. "You reread the text before you send it" works. "You struggle
 * with self-worth in relationships" does not, and never will.
 *
 * Short. One line, one behaviour, set at display size, read in a second.
 *
 * DUTY OF CARE, which is not negotiable and is not a style note.
 * No line here may imply a woman caused abuse, trauma, illness, poverty,
 * discrimination, other people's behaviour, or anything else outside her
 * control. The section is about the part of a pattern that belongs to her,
 * because that is the part she can reach. It is never about blame.
 */

export type HomeArea = 'love' | 'wealth' | 'self' | 'life'

export interface PainBlock {
  /** The single word set at display size. */
  word: string
  /** The area hue, for the hairline. Never a coloured card. */
  area: HomeArea
  /** One behaviour per line. Empty until Quiana's lines arrive. */
  lines: readonly string[]
  /** The turn at the end of the block - the cost, named plainly. */
  close?: string
}

/**
 * The four, in the order the storyboard sets: love, money, success, then
 * manifestation - which lands last because it is the one that reframes the
 * other three.
 */
export const pain: readonly PainBlock[] = [
  { word: 'Love', area: 'love', lines: [] },
  { word: 'Money', area: 'wealth', lines: [] },
  { word: 'Success', area: 'life', lines: [] },
  { word: 'Manifestation', area: 'self', lines: [] },
]

/** True when there is enough written to show the section at all. */
export const painIsWritten = pain.some((block) => block.lines.length > 0)

/**
 * The after.
 *
 * Same shape, same rules, and the same warning: these are placeholders in
 * Quiana's structure rather than her voice, kept deliberately plain so they
 * are easy to replace and impossible to mistake for finished copy. Present
 * tense, second person, and behaviour rather than feeling - the after has to
 * be recognisable in the same way the before is.
 */
export const possibility: readonly PainBlock[] = [
  { word: 'Love', area: 'love', lines: [] },
  { word: 'Money', area: 'wealth', lines: [] },
  { word: 'Success', area: 'life', lines: [] },
  { word: 'Receiving', area: 'self', lines: [] },
]

export const possibilityIsWritten = possibility.some(
  (block) => block.lines.length > 0,
)

/** The hairline colour for each area. Thin rules and small marks only. */
export const areaRule: Record<HomeArea, string> = {
  love: 'border-area-love',
  wealth: 'border-area-wealth',
  self: 'border-area-self',
  life: 'border-area-life',
}

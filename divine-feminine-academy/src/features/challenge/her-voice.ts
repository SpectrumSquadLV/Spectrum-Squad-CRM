/**
 * HER, in her own hand.
 *
 * Quiana's voice is the serif: it addresses a woman directly and tells her
 * the truth. HER is not a second narrator and not a character with a face -
 * she is what the woman is walking towards - so giving her dialogue would be
 * a mistake. She gets HANDWRITING instead.
 *
 * A line in this hand arrives rarely and never explains itself. By Day 7 a
 * woman should recognise the handwriting before she has read the words, and
 * that recognition is the entire mechanism: HER has been present the whole
 * week without ever having been a voice in a box.
 *
 * Which means the scarcity is load-bearing. At most one of these per day,
 * usually fewer - a hand that shows up on every screen is a decorative font,
 * and the moment it reads as decoration it can never be read as her again.
 *
 * They are also never instructions. "you already know" is not a prompt and
 * there is nothing to do about it; it is overheard. Anything that asks the
 * woman for something belongs in the curriculum, in Quiana's voice, where a
 * woman can tell who is asking.
 */

export interface HerLine {
  /** Referenced from a block's config. */
  key: string
  text: string
  /** Where it lands, for whoever edits this next. */
  where: string
}

export const herLines: readonly HerLine[] = [
  {
    key: 'you-already-know',
    text: 'you already know',
    where:
      'Day 1, at the very end - the first time HER appears at all. Day 1 is ' +
      'about meeting ME, so this is not a reveal: it is a woman catching ' +
      'something out of the corner of her eye on the way out of the room.',
  },
] as const

export function herLine(key: string): HerLine | undefined {
  return herLines.find((l) => l.key === key)
}

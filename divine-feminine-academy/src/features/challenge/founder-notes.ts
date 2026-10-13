/**
 * Quiana, in the room, before the hardest screens.
 *
 * The seven days are written in the second person: they speak TO a woman and
 * ask things OF her. That is right for the work, and it leaves one thing
 * unsaid — who is asking, and why she is allowed to.
 *
 * These notes are the answer. They appear immediately before a mirror, which
 * is the only place in the challenge where a woman is asked to do something
 * genuinely hard with nothing on screen to hide behind.
 *
 * TWO KINDS OF TRUTH LIVE IN THIS FILE, AND THEY ARE NOT INTERCHANGEABLE.
 *
 * The PROMISE — that she has been here, that she is not watching from above,
 * that the aim is a whole life and not a tolerable one — Quiana has already
 * stated in her own words, and it is written below in her voice.
 *
 * The HISTORY — what actually happened to her, when, and what it cost — is
 * hers alone and is NOT in this file. Every `origin` array below is empty on
 * purpose. An invented origin story is the one thing on this platform a reader
 * would be entirely right to distrust everything else for, and no amount of
 * plausibility makes a fabricated life safe to publish under a real woman's
 * name. Empty is correct until she writes it.
 *
 * `status` says which of the two a note currently is. A note marked 'draft' is
 * written FROM her instruction and is waiting for her to change the words to
 * the ones she would actually say; nothing is hidden from a member because of
 * it, because the promise is true either way. Change it to 'hers' when she has
 * read it and said yes.
 *
 * One string per paragraph. The block handles every other decision.
 */

export interface FounderNote {
  key: string
  /** Where it appears, for the admin and for whoever edits this next. */
  where: string
  /** Small, above her name. Never a sentence. */
  eyebrow: string
  /**
   * What she says. Written in her voice, second person, short lines.
   */
  paragraphs: readonly string[]
  /**
   * The specific, personal part — what happened to her.
   *
   * EMPTY UNTIL QUIANA WRITES IT. Shown after `paragraphs`, set apart, and
   * simply absent when she has not. The note reads completely without it, so
   * an empty array is a quieter note, never a broken one.
   */
  origin: readonly string[]
  status: 'draft' | 'hers'
}

export const founderNotes: readonly FounderNote[] = [
  {
    key: 'before-the-first-mirror',
    where: 'Day 1, immediately before the first one-minute mirror',
    eyebrow: 'Before you look',
    status: 'draft',
    paragraphs: [
      'I am going to ask you to do something in a moment that sounds small and is not.',
      'I have stood where you are about to stand. Not as a story I tell — as a thing I did, badly, for a long time, before I could do it for a full minute.',
      'So I know what the first minute is like. I know the urge to check your teeth, fix your hair, find something to correct. I know that looking at your own eyes can feel like being caught.',
      'Stay anyway. That is the whole instruction.',
      'You are not here to become a better-behaved version of who you have been. You are here to meet the woman who was always underneath, and then to live like her — not a smaller life that you talk yourself into, not a life that is fine. A whole one.',
      'That is what I am here for. I am not above you telling you how. I am a few steps along, turning around.',
    ],
    origin: [],
  },
  {
    key: 'before-the-hardest-mirror',
    where: 'Day 4, before the mirror, on the day the pattern gets named',
    eyebrow: 'A word, before this one',
    status: 'draft',
    paragraphs: [
      'Day 4 is the one women tell me they nearly did not open.',
      'If today has been heavy, that is not you doing it wrong. Seeing the pattern is the part that changes things, and it is also the part that hurts. Both of those are true at once and neither cancels the other.',
      'I want to be plain about one thing, because it matters and it gets said badly everywhere else.',
      'The pattern you are looking at is not the same as the things that happened to you. You did not cause them. What you built afterwards to survive them was intelligent, and it worked — that is exactly why it is still running.',
      'You are not dismantling a fault. You are thanking something that is off duty now.',
      'Go and look at her. I will be here on the other side of it.',
    ],
    origin: [],
  },
] as const

export function founderNote(key: string): FounderNote | undefined {
  return founderNotes.find((n) => n.key === key)
}

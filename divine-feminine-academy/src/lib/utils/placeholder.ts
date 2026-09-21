/**
 * Build markers, and the one rule about them.
 *
 * The curriculum seeds every unwritten prompt as [NEEDS QUIANA'S INPUT] on
 * purpose: the STRUCTURE of a challenge is decided, the WORDS are hers, and a
 * marker in the database is how the admin shows her what is still waiting.
 *
 * That is fine everywhere except one place. A marketing page reads the same
 * rows, and a programme description that is still a marker would render
 * "[NEEDS QUIANA'S INPUT]" to a stranger as though it were the promise. So
 * every public page runs text through this first, gets null for anything
 * unwritten, and shows a staff note only she can see instead.
 *
 * Matched loosely - NEEDS QUIANA, needs quiana's input, TODO in brackets -
 * because the cost of catching one sentence too many is a slightly emptier
 * page, and the cost of missing one is a build note in a headline.
 */
const MARKER = /\[?\s*(needs\s+quiana|todo|tbd|placeholder|lorem ipsum)/i

/** The text, or null when it is a build marker rather than real copy. */
export function publicText(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (MARKER.test(trimmed)) return null
  return trimmed
}

/** True when this text should never reach a stranger. */
export function isBuildMarker(value: string | null | undefined): boolean {
  return Boolean(value) && publicText(value) === null
}

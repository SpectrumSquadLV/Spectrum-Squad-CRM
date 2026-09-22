/**
 * A screen of copy is not a paragraph of copy.
 *
 * Every rich_text block used to render the same way: heading at one size,
 * paragraphs at another, on cream, in a 34rem column. Seven days of that is
 * an article. What the curriculum actually does changes enormously from
 * screen to screen - it introduces, it confronts a woman with her own
 * sentence, it holds one instruction alone before a mirror, it goes quiet at
 * the end - and none of that reached her, because the container never moved.
 *
 * A scene is the environment a passage lives in. It changes ground, scale,
 * measure and rhythm. It NEVER changes a word.
 *
 * That last point is the whole safety property of this file and it is
 * enforced by a check: verify:scenes renders every scene and asserts the text
 * that comes out is exactly the text that went in. A design system that can
 * silently drop a line of Quiana's curriculum is worse than no design system.
 */

export type Scene =
  /** The default. Editorial, cream, a comfortable measure. */
  | 'page'
  /** A day opening. Oversized title, air, the body set beneath it. */
  | 'chapter'
  /**
   * Near-black, edge to edge, her own words at display scale.
   *
   * For the screen that reads a woman's own sentence back to her. Day 1's
   * REFLECTION is the archetype: she typed the trigger ninety seconds ago and
   * now it is the largest thing she has seen all day, in the dark, with
   * "That's her." underneath it.
   */
  | 'confront'
  /** One line, enormous, alone. Everything else gets out of its way. */
  | 'declaration'
  /** The end of a day. Small, quiet, a great deal of space around it. */
  | 'close'

export const darkScenes: ReadonlySet<Scene> = new Set<Scene>(['confront'])

export function isDark(scene: Scene): boolean {
  return darkScenes.has(scene)
}

/**
 * What a paragraph IS, judged by its shape alone.
 *
 * Deliberately structural rather than semantic. Nothing here looks for
 * particular words, so a curriculum edit cannot break the rendering and no
 * passage is special-cased by its content - the same rules give the same
 * result on a screen nobody has written yet.
 *
 * - `label`  a single line ending in a colon. "THIS HAPPENED:" is a frame
 *            around her answer, not a sentence, and it should recede so the
 *            answer can be the thing she looks at.
 * - `litany` three or more short lines inside ONE paragraph. Day 1's "She
 *            overthinks. / She shuts down. / She chases." is a list of ways
 *            ME moves through the world, and set as prose it reads as one
 *            long sentence. Stacked, it reads as the drumbeat it is - and
 *            the compression is exactly ME's visual language.
 * - `beat`   a very short standalone paragraph. "That's her." "ME showed
 *            up." These are the pivots the curriculum turns on and they are
 *            the first thing lost when everything is 18px.
 * - `prose`  everything else.
 */
export type ParagraphKind = 'label' | 'litany' | 'beat' | 'prose'

/*
 * Words, not characters: a short line of long words is still a short line.
 *
 * Six rather than five. Five was a panicked overcorrection after the first
 * render came back with a wall of display type, and it silently demoted the
 * lines each screen actually turns on - "We're just going to notice her." and
 * "Today, you're going to SEE ME." both sit at exactly six. The wall was
 * never caused by the threshold; it was caused by promoting every beat in a
 * run, which promotedBeats now handles on its own.
 */
const BEAT_MAX_WORDS = 6
const LITANY_MIN_LINES = 3
const LITANY_MAX_WORDS_PER_LINE = 8

export function classify(paragraph: string): ParagraphKind {
  const lines = paragraph.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return 'prose'

  if (lines.length === 1) {
    const line = lines[0]!.trim()
    if (line.endsWith(':')) return 'label'
    if (words(line) <= BEAT_MAX_WORDS) return 'beat'
    return 'prose'
  }

  const short = lines.every((l) => words(l) <= LITANY_MAX_WORDS_PER_LINE)
  if (lines.length >= LITANY_MIN_LINES && short) return 'litany'

  return 'prose'
}

function words(line: string): number {
  return line.trim().split(/\s+/).filter(Boolean).length
}

/** Paragraphs, with the empties gone. The one place splitting is defined. */
export function paragraphs(body: string): string[] {
  return body.split('\n\n').filter((p) => p.trim() !== '')
}

export function lines(paragraph: string): string[] {
  return paragraph.split('\n').filter((l) => l.trim() !== '')
}


/**
 * Which beats actually get to be loud.
 *
 * The first version promoted every short paragraph to display size, and Day 1
 * came back with six enormous lines stacked down one screen - "That's her."
 * then "No judgment." then "No fixing." all at the same weight. That is not
 * emphasis. Emphasis is a contrast, and a page where every short line shouts
 * has thrown the contrast away.
 *
 * Quiana writes in short paragraphs separated by blank lines, so a RUN of
 * them is a single rhetorical gesture - the same device as the litany, just
 * spaced out. The first line of a run is the pivot and carries the screen;
 * the rest of the run belongs underneath it, quiet.
 *
 * `declaration` promotes nothing at all. That scene already has one enormous
 * line in the heading, and a body competing with it would mean the screen has
 * two things to look at when the entire point is that it has one.
 */
export function promotedBeats(kinds: readonly ParagraphKind[], scene: Scene): boolean[] {
  return kinds.map((kind, i) => {
    if (kind !== 'beat') return false
    if (scene === 'declaration') return false
    return kinds[i - 1] !== 'beat'
  })
}

/**
 * A paragraph that is the ANSWER to the label above it.
 *
 * On the confronting screen "THIS HAPPENED:" is a frame and the sentence
 * under it is what she typed ninety seconds ago. That sentence is the reason
 * the screen exists, so it cannot be the smallest thing on it - which is
 * exactly what it was, while "That's her." was three times its size.
 */
export function answersLabel(kinds: readonly ParagraphKind[]): boolean[] {
  return kinds.map((kind, i) => kind === 'prose' && kinds[i - 1] === 'label')
}

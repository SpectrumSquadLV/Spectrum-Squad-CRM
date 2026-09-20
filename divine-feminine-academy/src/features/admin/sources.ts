/**
 * Turning a stored source into something a human can read.
 *
 * Sources are written as machine strings at the moment somebody arrives -
 * `quiz:which-version`, `writing:almost-ready-is-a-decision`,
 * `archetype-opt-in:the-watcher`. That is right for storage and useless on a
 * screen. This is the one place that translates them.
 *
 * Two rules. An unknown source is shown AS IT WAS STORED rather than as
 * "Other", because the question being asked is "where did she come from" and
 * hiding the answer behind a bucket defeats the point. And nothing is ever
 * invented: if a slug is all there is, the slug is what you see.
 *
 * Pure. No database, no React.
 */

export type SourceGroup =
  | 'quiz'
  | 'writing'
  | 'challenge'
  | 'course'
  | 'assessment'
  | 'cohort'
  | 'direct'
  | 'other'

export interface SourceLabel {
  group: SourceGroup
  /** What it says on the screen. */
  label: string
  /** The second line, when there is more to say. */
  detail: string | null
}

const ARCHETYPE_NAMES: Record<string, string> = {
  'the-commander': 'The Commander',
  'the-escape-artist': 'The Escape Artist',
  'the-watcher': 'The Watcher',
  'the-quiet-storm': 'The Quiet Storm',
}

const PROGRAM_NAMES: Record<string, string> = {
  'me-vs-her': 'ME VS HER',
  'the-divine-feminine': 'The Divine Feminine',
}

/** Turn a slug into something readable when nothing better is known. */
function humanise(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
}

export function describeSource(raw: string | null | undefined): SourceLabel {
  const source = (raw ?? '').trim()
  if (!source) {
    return {
      group: 'direct',
      label: 'Straight to the site',
      detail: 'No campaign, no quiz, no piece of writing — she just arrived.',
    }
  }

  const [head, ...rest] = source.split(':')
  const tail = rest.join(':')

  switch (head) {
    case 'quiz':
      return { group: 'quiz', label: 'The quiz', detail: 'She answered the twelve questions.' }

    case 'quiz-waitlist':
      return { group: 'quiz', label: 'The quiz', detail: 'Asked to be told when it was ready.' }

    case 'archetype-opt-in':
      return {
        group: 'quiz',
        label: 'Recognised herself',
        detail: tail
          ? `${ARCHETYPE_NAMES[tail] ?? humanise(tail)} — she opted in without taking the quiz.`
          : 'She opted in from an archetype page without taking the quiz.',
      }

    case 'writing':
      return {
        group: 'writing',
        label: 'Something you wrote',
        detail:
          !tail || tail === 'index'
            ? 'From the writing index rather than one piece.'
            : humanise(tail),
      }

    case 'checkout':
      if (tail === 'me-vs-her') {
        return { group: 'challenge', label: 'Bought ME VS HER', detail: 'Her first purchase was the challenge.' }
      }
      return {
        group: 'course',
        label: tail ? `Bought ${PROGRAM_NAMES[tail] ?? humanise(tail)}` : 'Bought something',
        detail: 'She arrived at checkout without being on the list first.',
      }

    case 'assessment':
      return { group: 'assessment', label: 'The assessment', detail: 'Self, Love, Life and Wealth.' }

    case 'cohort-waitlist':
      return {
        group: 'cohort',
        label: 'A cohort waitlist',
        detail: tail ? humanise(tail) : null,
      }

    case 'me-vs-her':
      return { group: 'challenge', label: 'ME VS HER', detail: 'From the challenge page itself.' }

    default:
      // Deliberately shown as stored. A source nobody has taught this function
      // about is still the truthful answer to "where did she come from".
      return { group: 'other', label: humanise(source), detail: null }
  }
}

/** Rolls the detailed sources up into the handful of buckets worth charting. */
export const GROUP_LABELS: Record<SourceGroup, string> = {
  quiz: 'The quiz',
  writing: 'Writing',
  challenge: 'ME VS HER',
  course: 'The Divine Feminine',
  assessment: 'The assessment',
  cohort: 'Cohort waitlists',
  direct: 'Straight to the site',
  other: 'Everything else',
}

export function groupOf(raw: string | null | undefined): SourceGroup {
  return describeSource(raw).group
}

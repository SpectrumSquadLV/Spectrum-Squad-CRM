/**
 * The four versions of her.
 *
 * Every one of these is a PROTECTIVE MODE, not a personality defect. Fight,
 * flight, freeze and sulk are what a nervous system does when something is
 * unsafe, and they are all - every one of them - a form of self-protection
 * that worked at the time. A quiz that tells a woman she is broken converts
 * once and then she never opens an email again. A quiz that tells her what she
 * has been protecting converts, and she forwards it to three friends.
 *
 * So the copy rule for this file: name the behaviour honestly, name the cost
 * honestly, and never imply she is the problem. The mode is the problem, and
 * the mode is not her.
 *
 * Pure data and pure functions. No database, no clock, no React - so the
 * scoring can be tested directly and the copy can be read by a non-developer
 * in one sitting and edited without touching anything that runs.
 */

import type { Area } from '@/features/assessment/scoring'

/**
 * The four modes.
 *
 * DECLARATION ORDER IS LOAD-BEARING. It is the tie-break when two modes score
 * identically, which is what makes the result deterministic: the same answers
 * always produce the same version, no matter how the object is iterated.
 */
export const modes = ['fight', 'flight', 'freeze', 'sulk'] as const
export type ProtectiveMode = (typeof modes)[number]

export function isMode(value: unknown): value is ProtectiveMode {
  return typeof value === 'string' && (modes as readonly string[]).includes(value)
}

export interface Archetype {
  mode: ProtectiveMode
  /** URL segment for the public, shareable page. */
  slug: string
  name: string
  /** Under the name, on the result and on the share card. */
  tagline: string
  /** One sentence she would actually say out loud about herself. */
  oneLiner: string
  /** What it sounds like in her head. Her words, not a clinician's. */
  soundsLike: string[]
  /** What other people see. Behaviour, not feeling. */
  looksLike: string[]
  /** The reframe. This is the line that makes her cry, and it must be true. */
  protecting: string
  /** The honest cost. No softening - she already knows, and pretending insults her. */
  costs: string
  /** The one move back to herself. Small enough to do today. */
  theReturn: string
  /** Concrete, today, under two minutes. */
  firstStep: string
  /** Which room it is usually loudest in. */
  area: Area
  /** What she posts. Written to be screenshot. */
  shareLine: string
}

/**
 * THE COPY.
 *
 * This is a first draft written to be replaced. It is real writing rather than
 * a placeholder because a quiz with `[PLACEHOLDER]` in the result is a quiz
 * nobody can test on a real person - but every word here should be read aloud
 * by the woman whose brand it is, and changed until it sounds like her.
 */
export const archetypes: Record<ProtectiveMode, Archetype> = {
  fight: {
    mode: 'fight',
    slug: 'the-commander',
    name: 'The Commander',
    tagline: 'You handle it. You have always handled it.',
    oneLiner:
      'When something threatens you, you get bigger, faster and more competent — and you do it alone.',
    soundsLike: [
      'If I do not do it, it does not get done.',
      'I am not upset, I am just being realistic.',
      'I will rest when this is finished.',
    ],
    looksLike: [
      'You take over the moment something wobbles.',
      'You argue the point long after you stopped caring about the point.',
      'You are the one everybody calls, and nobody checks on.',
    ],
    protecting:
      'Control. Somewhere back there, being in charge was the only thing that kept you safe — so now being out of control feels like danger rather than discomfort. Your competence is not a performance. It is a shield you have been carrying so long you forgot to put it down.',
    costs:
      'You are exhausted and nobody knows, because you have trained everyone around you to believe you do not need anything. Help feels like an insult. Softness feels like exposure. And the people who love you are standing outside a door you keep telling them is not locked.',
    theReturn:
      'Let one thing be done badly by someone else, on purpose, and do not fix it.',
    firstStep:
      'Think of one thing you are carrying that is not actually yours. Today, say one sentence out loud: “I need help with this.” Do not explain it, do not soften it, do not add “but it is fine”.',
    area: 'self',
    shareLine:
      'I got The Commander — the version of me that handles everything and asks for nothing.',
  },

  flight: {
    mode: 'flight',
    slug: 'the-escape-artist',
    name: 'The Escape Artist',
    tagline: 'You do not stay long enough to be let down.',
    oneLiner:
      'When something threatens you, you find the exit — a new plan, a new city, a new version of your life — before it can find you.',
    soundsLike: [
      'I think I have outgrown this.',
      'I just need a fresh start.',
      'I am not running. I am being smart.',
    ],
    looksLike: [
      'You start beautifully and leave at the boring part.',
      'You keep one foot out of every door — the job, the lease, the relationship.',
      'You stay so busy that nothing can catch up with you, including you.',
    ],
    protecting:
      'Your freedom. At some point staying cost you something you could not afford, so leaving became the fastest way to feel safe. You are not flaky. You are fast — and you learned to be fast because being trapped once nearly finished you.',
    costs:
      'Nothing gets deep enough to hold you. You have a history of beginnings and almost no endings you chose. And the thing you actually want — to be somewhere, with someone, and stay — is the one thing the exit strategy will not let you build.',
    theReturn: 'Stay in one uncomfortable conversation past the moment you want to go.',
    firstStep:
      'Name the thing you are currently halfway out of. Do not decide anything about it. Just write down one honest sentence about what you would lose if you left — and let it be true for ten minutes.',
    area: 'life',
    shareLine:
      'I got The Escape Artist — the version of me that leaves before she can be left.',
  },

  freeze: {
    mode: 'freeze',
    slug: 'the-watcher',
    name: 'The Watcher',
    tagline: 'You are waiting until you are sure. You have been waiting a while.',
    oneLiner:
      'When something threatens you, you go still — researching, preparing, almost-ready — because moving in the wrong direction feels worse than not moving at all.',
    soundsLike: [
      'I just need to think about it a bit more.',
      'Now is not the right time.',
      'I do not want to do it until I can do it properly.',
    ],
    looksLike: [
      'You have drafts, plans and a folder of screenshots, and you have posted none of it.',
      'You go quiet in the room where you have the most to say.',
      'You scroll the evening away and cannot account for it afterwards.',
    ],
    protecting:
      'Yourself, from being wrong in public. Stillness is not laziness — it is the oldest safety there is. Somewhere you learned that being seen making a mistake was dangerous, and so you got very, very good at not being seen.',
    costs:
      'Time. Quietly and enormously. The life you are researching is being lived by women with half your thought and twice your nerve, and the gap between what you know and what you have done is the thing that keeps you awake.',
    theReturn: 'Do it at sixty per cent ready, where somebody can see.',
    firstStep:
      'Pick the smallest version of the thing you have been almost-doing. Set a timer for ten minutes. Do it badly, on purpose, and finish before the timer does.',
    area: 'wealth',
    shareLine:
      'I got The Watcher — the version of me who is always almost ready.',
  },

  sulk: {
    mode: 'sulk',
    slug: 'the-quiet-storm',
    name: 'The Quiet Storm',
    tagline: 'You went quiet. You are still keeping score.',
    oneLiner:
      'When something threatens you, you withdraw — you say you are fine, you give less, and you wait to be noticed.',
    soundsLike: [
      'It is fine. Honestly. Forget it.',
      'After everything I do for them.',
      'If they cared, they would already know.',
    ],
    looksLike: [
      'You go short, polite and very, very quiet.',
      'You do the thing they asked, perfectly, with an atmosphere attached.',
      'You keep a private ledger of everything you have given and everything you did not get back.',
    ],
    protecting:
      'Your dignity. Asking directly and being refused is a particular kind of humiliation, and you decided a long time ago not to risk it again. Going quiet is not manipulation. It is what asking turns into when asking stopped working.',
    costs:
      'The one thing you want — to be chosen without having to beg for it — is the one thing silence guarantees you will not get. Resentment is heavy, it is private, and it is eating the relationships you are trying to protect.',
    theReturn: 'Say the unmet want out loud, plainly, before it becomes a grudge.',
    firstStep:
      'Find one thing you are quietly angry about. Write the sentence you actually mean, starting with “I wanted”. You do not have to send it. You have to admit it.',
    area: 'love',
    shareLine:
      'I got The Quiet Storm — the version of me who says she is fine and keeps the receipts.',
  },
}

export const archetypeList: Archetype[] = modes.map((m) => archetypes[m])

export function archetypeBySlug(slug: string): Archetype | null {
  return archetypeList.find((a) => a.slug === slug) ?? null
}

/** Weights a single option contributes, e.g. { fight: 2, sulk: 1 }. */
export type ModeWeights = Partial<Record<ProtectiveMode, number>>

export interface QuizQuestion {
  id: string
  /** Only multiple_choice questions carry weights; anything else is ignored. */
  type: 'likert' | 'multiple_choice' | 'open'
  config: {
    options?: Array<{ value: string; label?: string; weights?: ModeWeights }>
  }
}

export interface QuizAnswer {
  questionId: string
  value: unknown
}

export interface ModeTally {
  mode: ProtectiveMode
  /** Raw weight collected. */
  points: number
  /** Share of all points collected, 0-100. */
  share: number
}

export interface ArchetypeResult {
  /** Null only when nothing she answered carried any weight. */
  primary: ProtectiveMode | null
  /** The runner-up, when it is close enough to be worth naming. */
  secondary: ProtectiveMode | null
  tallies: ModeTally[]
  answered: number
  /**
   * True when primary and secondary are within `blendWithin` points of share.
   *
   * Ten points, because with four modes a real spread is something like
   * 40/30/20/10 — so a gap of ten is genuinely close, and naming the runner-up
   * at that distance is both true and the part women quote back. Much wider
   * and every result turns into a mush of "you are a bit of everything",
   * which is the failure mode of most quizzes on the internet.
   */
  isBlend: boolean
}

const emptyTallies = (): Record<ProtectiveMode, number> => ({
  fight: 0,
  flight: 0,
  freeze: 0,
  sulk: 0,
})

/**
 * Score a set of answers into one of the four.
 *
 * Deliberate choices:
 *
 * - A weight of zero is not the same as no weight. An option can legitimately
 *   say "this is a little bit fight", and that has to be able to lose to an
 *   option that is strongly fight.
 * - Negative weights are rejected rather than clamped, because a negative
 *   weight in the seed data is a mistake, and silently treating it as zero
 *   would hide it forever.
 * - The tie-break is declaration order, NOT insertion or iteration order, so
 *   the same answers always produce the same woman's result. Two runs that
 *   disagree would be worse than either answer.
 */
export function scoreArchetypes(
  questions: QuizQuestion[],
  answers: QuizAnswer[],
  { blendWithin = 10 }: { blendWithin?: number } = {},
): ArchetypeResult {
  const byId = new Map(answers.map((a) => [a.questionId, a.value]))
  const points = emptyTallies()
  let answered = 0

  for (const question of questions) {
    if (question.type !== 'multiple_choice') continue

    const value = byId.get(question.id)
    if (value === null || value === undefined || value === '') continue

    const chosen = (question.config.options ?? []).find(
      (o) => o.value === String(value),
    )
    if (!chosen) continue

    answered++

    for (const [mode, weight] of Object.entries(chosen.weights ?? {})) {
      if (!isMode(mode)) continue
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
        continue
      }
      points[mode] += weight
    }
  }

  const total = modes.reduce((sum, m) => sum + points[m], 0)

  const tallies: ModeTally[] = modes.map((mode) => ({
    mode,
    points: points[mode],
    share: total > 0 ? Math.round((points[mode] / total) * 100) : 0,
  }))

  if (total === 0) {
    return { primary: null, secondary: null, tallies, answered, isBlend: false }
  }

  // Declaration order is preserved by `modes`, and `>` (not `>=`) keeps the
  // earliest-declared mode on a tie.
  const ranked = [...tallies].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points
    return modes.indexOf(a.mode) - modes.indexOf(b.mode)
  })

  const first = ranked[0]!
  const second = ranked[1]!
  const isBlend = second.points > 0 && first.share - second.share <= blendWithin

  return {
    primary: first.mode,
    secondary: isBlend ? second.mode : null,
    tallies,
    answered,
    isBlend,
  }
}

/**
 * The name without its article, for use mid-sentence.
 *
 * "with a strong The Quiet Storm" is the kind of thing that survives review
 * and then greets ten thousand women on their result page.
 */
export function bareName(archetype: Archetype): string {
  return archetype.name.replace(/^The /, '')
}

/** The headline sentence on the result page. */
export function resultHeadline(result: ArchetypeResult): string | null {
  if (!result.primary) return null
  const primary = archetypes[result.primary]
  if (!result.secondary) return primary.name
  return `${primary.name}, with a strong ${bareName(archetypes[result.secondary])}`
}

/** What changed between two attempts, in points of share. */
export function compareArchetypes(
  before: ArchetypeResult,
  after: ArchetypeResult,
) {
  return modes.map((mode) => {
    const b = before.tallies.find((t) => t.mode === mode)?.share ?? 0
    const a = after.tallies.find((t) => t.mode === mode)?.share ?? 0
    return { mode, before: b, after: a, delta: a - b }
  })
}

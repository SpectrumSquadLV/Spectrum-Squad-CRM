/**
 * THE FOUR VERSIONS OF ME.
 *
 * Not four personality types. Four strategies ME uses, and ME is the version
 * of her whose whole job has been to make her feel good enough.
 *
 * ME developed these through experience. She defends, controls, withdraws,
 * escapes, proves herself, seeks validation, keeps score - and every one of
 * those was, at some point, the thing that worked. Fight, flight, freeze and
 * sulk are what a nervous system does when something is unsafe.
 *
 * ME IS NOT THE ENEMY. This is the line the whole quiz turns on. The
 * progression is see ME, understand ME, love ME, recognise what ME has been
 * creating, and only then meet HER. ME is not destroyed or rejected at the
 * end of it: she is understood, thanked, and allowed to retire from a job she
 * no longer has to do. HER does not spend her life trying to feel good
 * enough, because HER already knows she is.
 *
 * So the copy rule for this file: name the behaviour honestly, name the cost
 * honestly, and never imply she is the problem. ME is not the problem either
 * - ME is the solution to a problem that has since passed.
 *
 * A quiz that tells a woman she is broken converts once and then she never
 * opens an email again. A quiz that tells her what she has been protecting
 * converts, and she forwards it to three friends.
 *
 * Pure data and pure functions. No database, no clock, no React - so the
 * scoring can be tested directly and the copy can be read by a non-developer
 * in one sitting and edited without touching anything that runs.
 */

import { areas as allAreas, type Area } from '@/features/assessment/scoring'

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
  /**
   * The signature line. Under the name on the reveal and on the share card.
   *
   * These four are Quiana's, word for word. They are the sentence a woman
   * reads immediately after her own sigil finishes drawing, which makes them
   * the highest-stakes copy in the whole instrument.
   */
  tagline: string
  /**
   * One line under the signature, saying what this protector learned.
   *
   * Null where the doctrine has not been approved - it renders nothing rather
   * than being filled in by whoever is next in this file.
   */
  revealNote: string | null
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
 * THE COPY, in Quiana's register.
 *
 * The first draft of this was mine and it read like a copywriter: "you are"
 * where she says "you're", long literary sentences, em-dashes stacked three
 * deep, and the occasional flourish that sounds good and says nothing. This
 * is the same psychology set in her voice instead, taken from eighty-three
 * behaviours she wrote for the home page, her four signature lines, and her
 * three reveal notes.
 *
 * WHAT HER VOICE ACTUALLY DOES, from those:
 *
 *   Short declaratives. Two clauses, usually. "You keep score."
 *   Contractions everywhere. "You're", "isn't", "didn't", "they'd".
 *   The reframe is a pair: "X isn't Y. It's Z."
 *   The reader is YOU. The archetype is SHE. She switches deliberately -
 *     "Her silence is not emptiness" - and the distance is the point: the
 *     protector is someone the woman can look at rather than something she
 *     is accused of being.
 *   No therapy words. No flourishes she would not say out loud.
 *
 * WHAT WAS CUT and why: a line about the life she is researching being lived
 * by "women with half your thought and twice your nerve". It is quotable, and
 * it buys its punch by putting other women down, which is not what this is.
 *
 * THE WATCHER IS DELIBERATELY THE THINNEST. Her psychology is still
 * provisional in the methodology and the instruction was not to expand her
 * doctrine. What is here says what freeze DOES - the frame Quiana set - and
 * makes no claim about where hers came from. She gets her doctrine when
 * Quiana writes it.
 *
 * The tagline and revealNote on all four are Quiana's, word for word.
 * Everything else is her psychology in her register, and still hers to change.
 */
export const archetypes: Record<ProtectiveMode, Archetype> = {
  fight: {
    mode: 'fight',
    slug: 'the-commander',
    name: 'The Commander',
    tagline: 'You handle it. You’ve always handled it.',
    revealNote:
      'The Commander learned that being powerful could keep her from feeling powerless.',
    oneLiner:
      'This is the version of you who gets bigger the second something threatens her. Faster, more capable, more in charge. And alone.',
    soundsLike: [
      'If I don’t do it, it doesn’t get done.',
      'I’m not upset. I’m being realistic.',
      'I’ll rest when this is finished.',
    ],
    looksLike: [
      'You take over the second something wobbles.',
      'You’re still arguing the point long after you stopped caring about the point.',
      'You’re the one everybody calls. Nobody calls to check on you.',
    ],
    protecting:
      'Control. Being in charge was once the only thing that kept you safe, so being out of control doesn’t feel uncomfortable to you. It feels dangerous. Your competence isn’t a performance. It’s armour, and you’ve worn it so long you forgot you put it on.',
    costs:
      'You’re exhausted and nobody knows, because you trained everyone around you to believe you don’t need anything. Help feels like an insult. Softness feels like exposure. And the people who love you are standing outside a door you keep telling them isn’t locked.',
    theReturn: 'Let one thing be done badly by someone else. Don’t fix it.',
    firstStep:
      'Find one thing you’re carrying that was never yours. Today, say one sentence out loud: “I need help with this.” Don’t explain it. Don’t soften it. Don’t add “but it’s fine”.',
    area: 'self',
    shareLine:
      'I got The Commander — the version of me who handles everything and asks for nothing.',
  },

  flight: {
    mode: 'flight',
    slug: 'the-escape-artist',
    name: 'The Escape Artist',
    tagline: 'You don’t stay long enough to be let down.',
    revealNote:
      'She learned that distance could provide relief from what she didn’t yet know how to sit with.',
    oneLiner:
      'This is the version of you who finds the exit first. A new plan, a new city, a new version of your life — before anything can find her.',
    soundsLike: [
      'I think I’ve outgrown this.',
      'I just need a fresh start.',
      'I’m not running. I’m being smart.',
    ],
    looksLike: [
      'You start beautifully and leave at the boring part.',
      'You keep one foot out of every door. The job, the lease, the relationship.',
      'You stay so busy nothing can catch up with you. Including you.',
    ],
    protecting:
      'Your freedom. Staying cost you something once that you couldn’t afford, so leaving became the fastest way to feel safe. You’re not flaky. You’re fast — and you learned to be fast because being trapped once nearly finished you.',
    costs:
      'Nothing gets deep enough to hold you. You have a history of beginnings and almost no endings you chose. And the thing you actually want — to be somewhere, with someone, and stay — is the one thing the exit strategy won’t let you build.',
    theReturn:
      'Stay in one uncomfortable conversation past the moment you want to go.',
    firstStep:
      'Name the thing you’re currently halfway out of. Don’t decide anything about it. Write one honest sentence about what you’d lose if you left, and let it be true for ten minutes.',
    area: 'life',
    shareLine:
      'I got The Escape Artist — the version of me who leaves before she can be left.',
  },

  freeze: {
    mode: 'freeze',
    slug: 'the-watcher',
    name: 'The Watcher',
    tagline: 'You wait. You watch. You make sure.',
    /*
     * Deliberately absent.
     *
     * The Watcher's psychology is still provisional in the methodology, and
     * the instruction was explicit: do not expand her doctrine beyond
     * approved copy. A second line here would be me writing doctrine, so
     * there is no second line until Quiana writes one.
     */
    revealNote: null,
    oneLiner:
      'This is the version of you who goes still. Researching, preparing, almost ready — because moving in the wrong direction feels worse than not moving at all.',
    soundsLike: [
      'I just need to think about it a bit more.',
      'Now isn’t the right time.',
      'I don’t want to do it until I can do it properly.',
    ],
    looksLike: [
      'You have drafts, plans and a folder of screenshots. You’ve posted none of it.',
      'You go quiet in the room where you have the most to say.',
      'You lose the evening to your phone and can’t account for it afterwards.',
    ],
    /*
     * What freeze DOES, which is the frame Quiana set, and no claim about
     * where hers came from. The other three say what their protector learned;
     * this one cannot until she says so.
     */
    protecting:
      'Stillness. It isn’t laziness and it never was. It’s what happens when moving in the wrong direction feels more dangerous than staying where you are.',
    costs:
      'Time. Quietly, and enormously. The gap between what you know and what you’ve actually done is the thing that keeps you awake.',
    theReturn: 'Do it at sixty per cent ready, where somebody can see.',
    firstStep:
      'Pick the smallest version of the thing you’ve been almost-doing. Set a timer for ten minutes. Do it badly on purpose and finish before the timer does.',
    area: 'wealth',
    shareLine:
      'I got The Watcher — the version of me who’s always almost ready.',
  },

  sulk: {
    mode: 'sulk',
    slug: 'the-quiet-storm',
    name: 'The Quiet Storm',
    tagline: 'You went quiet. You’re still keeping score.',
    revealNote:
      'Her silence is not emptiness. There is usually something happening underneath it.',
    oneLiner:
      'This is the version of you who withdraws. Says she’s fine, gives a little less, and waits to be noticed.',
    soundsLike: [
      'It’s fine. Honestly. Forget it.',
      'After everything I do for them.',
      'If they cared, they’d already know.',
    ],
    looksLike: [
      'You go short, polite and very quiet.',
      'You do exactly what they asked, perfectly, with an atmosphere attached.',
      'You keep a private ledger of what you’ve given and what you didn’t get back.',
    ],
    protecting:
      'Your dignity. Asking directly and being refused is a particular kind of humiliation, and you decided a long time ago not to risk it again. Going quiet isn’t manipulation. It’s what asking turns into when asking stopped working.',
    costs:
      'The one thing you want — to be chosen without having to ask for it — is the one thing silence guarantees you won’t get. Resentment is heavy, it’s private, and it’s eating the relationships you’re trying to protect.',
    theReturn:
      'Say the want out loud, plainly, before it turns into a grudge.',
    firstStep:
      'Find one thing you’re quietly angry about. Write the sentence you actually mean, starting with “I wanted”. You don’t have to send it. You have to admit it.',
    area: 'love',
    shareLine:
      'I got The Quiet Storm — the version of me who says she’s fine and keeps the receipts.',
  },
}

export const archetypeList: Archetype[] = modes.map((m) => archetypes[m])

export function archetypeBySlug(slug: string): Archetype | null {
  return archetypeList.find((a) => a.slug === slug) ?? null
}

/** Weights a single option contributes, e.g. { fight: 2, sulk: 1 }. */
export type ModeWeights = Partial<Record<ProtectiveMode, number>>

/** Where in her life an answer says the pattern is loudest. */
export type AreaWeights = Partial<Record<Area, number>>

export interface QuizQuestion {
  id: string
  /** Only multiple_choice questions carry weights; anything else is ignored. */
  type: 'likert' | 'multiple_choice' | 'open'
  config: {
    options?: Array<{
      value: string
      label?: string
      weights?: ModeWeights
      areas?: AreaWeights
    }>
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

export interface AreaTally {
  area: Area
  points: number
  /** Share of all area points collected, 0-100. */
  share: number
}

export interface ArchetypeResult {
  /**
   * NEVER null.
   *
   * It used to be nullable, and that nullability was the bug: a woman could
   * answer twelve questions and be told her answers "did not add up to
   * anything". There is no such thing as a completed quiz with no result.
   * Every path below resolves to one of the four, and `degenerate` records
   * the case where it had to be resolved without signal so it can be alerted
   * on rather than shown to her.
   */
  primary: ProtectiveMode
  /** The runner-up, when it is close enough to be worth naming. */
  secondary: ProtectiveMode | null
  tallies: ModeTally[]
  /** Where it is loudest. The other half of the same instrument. */
  areas: AreaTally[]
  /** The area with the most points, or null when no option carried any. */
  loudest: Area | null
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
  /**
   * Nothing she answered carried any weight, so `primary` was resolved by the
   * final tie-break rather than by her answers.
   *
   * This is a DEFECT IN THE DATA, not a fact about her: a published version
   * with no scoring questions, or options with no weights. She still gets a
   * result - she has to - and this flag is how the failure reaches a log
   * instead of reaching her.
   */
  degenerate: boolean
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
  const areaPoints: Record<Area, number> = { self: 0, love: 0, life: 0, wealth: 0 }

  /**
   * The two tie-breakers that mean something.
   *
   * `leads` counts the questions where a mode was the single strongest weight
   * in the option she chose - a protector she reached for outright, rather
   * than one that only ever came along with another. `lastSeen` is the
   * position of the last question where a mode scored at all; answers late in
   * a quiz are less shaped by the framing of the first one.
   */
  const leads = emptyTallies()
  const lastSeen: Record<ProtectiveMode, number> = {
    fight: -1,
    flight: -1,
    freeze: -1,
    sulk: -1,
  }

  let answered = 0
  let position = 0

  for (const question of questions) {
    position++
    if (question.type !== 'multiple_choice') continue

    const value = byId.get(question.id)
    if (value === null || value === undefined || value === '') continue

    const chosen = (question.config.options ?? []).find(
      (o) => o.value === String(value),
    )
    if (!chosen) continue

    answered++

    const valid: Array<[ProtectiveMode, number]> = []
    for (const [mode, weight] of Object.entries(chosen.weights ?? {})) {
      if (!isMode(mode)) continue
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        continue
      }
      valid.push([mode, weight])
    }

    for (const [mode, weight] of valid) {
      points[mode] += weight
      lastSeen[mode] = position
    }

    // The single strongest mode in this answer, if one is strictly strongest.
    if (valid.length > 0) {
      const top = Math.max(...valid.map(([, w]) => w))
      const atTop = valid.filter(([, w]) => w === top)
      if (atTop.length === 1) leads[atTop[0]![0]] += 1
    }

    for (const [area, weight] of Object.entries(chosen.areas ?? {})) {
      if (!allAreas.includes(area as Area)) continue
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        continue
      }
      areaPoints[area as Area] += weight
    }
  }

  const total = modes.reduce((sum, m) => sum + points[m], 0)
  const areaTotal = allAreas.reduce((sum, a) => sum + areaPoints[a], 0)

  const tallies: ModeTally[] = modes.map((mode) => ({
    mode,
    points: points[mode],
    share: total > 0 ? Math.round((points[mode] / total) * 100) : 0,
  }))

  const areaTallies: AreaTally[] = allAreas.map((area) => ({
    area,
    points: areaPoints[area],
    share: areaTotal > 0 ? Math.round((areaPoints[area] / areaTotal) * 100) : 0,
  }))

  /*
   * Four tiers, and the last one cannot fail.
   *
   * Points, then the protector she reached for outright most often, then the
   * one she was still reaching for latest in the quiz, then declaration
   * order. Declaration order alone used to decide every tie, which handed all
   * of them to The Commander and quietly biased the whole instrument toward
   * one archetype.
   */
  const ranked = [...tallies].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points
    if (leads[b.mode] !== leads[a.mode]) return leads[b.mode] - leads[a.mode]
    if (lastSeen[b.mode] !== lastSeen[a.mode]) {
      return lastSeen[b.mode] - lastSeen[a.mode]
    }
    return modes.indexOf(a.mode) - modes.indexOf(b.mode)
  })

  const first = ranked[0]!
  const second = ranked[1]!
  const isBlend =
    total > 0 && second.points > 0 && first.share - second.share <= blendWithin

  const loudest =
    areaTotal > 0
      ? [...areaTallies].sort((a, b) => {
          if (b.points !== a.points) return b.points - a.points
          return allAreas.indexOf(a.area) - allAreas.indexOf(b.area)
        })[0]!.area
      : null

  return {
    primary: first.mode,
    secondary: isBlend ? second.mode : null,
    tallies,
    areas: areaTallies,
    loudest,
    answered,
    isBlend,
    degenerate: total === 0,
  }
}

/**
 * Can this set of questions actually produce a result?
 *
 * The second way a completed quiz used to end in nothing: a published version
 * whose options carry no usable weights scores zero for everybody, and the
 * failure surfaces at the worst possible moment - to a woman who has just
 * answered twelve honest questions.
 *
 * So the check runs at PUBLISH time instead, where the person who caused it
 * is standing right there and can fix it in a minute. Returns the problems
 * rather than throwing, so a caller can show all of them at once instead of
 * making somebody fix them one deploy at a time.
 */
export function validateArchetypeVersion(questions: QuizQuestion[]): string[] {
  const problems: string[] = []

  const scoring = questions.filter((q) => q.type === 'multiple_choice')
  if (scoring.length === 0) {
    problems.push(
      'No multiple-choice questions. Nothing else carries weights, so every result would be resolved by tie-break.',
    )
  }

  const reachable = new Set<ProtectiveMode>()

  for (const question of scoring) {
    const options = question.config.options ?? []
    if (options.length === 0) {
      problems.push(`Question ${question.id} has no options.`)
      continue
    }

    for (const option of options) {
      const weights = Object.entries(option.weights ?? {}).filter(
        ([mode, w]) =>
          isMode(mode) && typeof w === 'number' && Number.isFinite(w) && w > 0,
      )
      if (weights.length === 0) {
        problems.push(
          `Question ${question.id}, option "${option.value}" carries no usable protector weight, so choosing it says nothing.`,
        )
      }
      for (const [mode] of weights) if (isMode(mode)) reachable.add(mode)

      const areaWeights = Object.entries(option.areas ?? {}).filter(
        ([area, w]) =>
          allAreas.includes(area as Area) &&
          typeof w === 'number' &&
          Number.isFinite(w) &&
          w > 0,
      )
      if (areaWeights.length === 0) {
        problems.push(
          `Question ${question.id}, option "${option.value}" carries no area weight, so it cannot say where this is loudest.`,
        )
      }
    }
  }

  // An archetype no answer can reach is a quiz nobody is ever told they are.
  for (const mode of modes) {
    if (!reachable.has(mode)) {
      problems.push(
        `Nothing can score ${archetypes[mode].name} (${mode}). No woman could ever receive this result.`,
      )
    }
  }

  return problems
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
export function resultHeadline(result: ArchetypeResult): string {
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

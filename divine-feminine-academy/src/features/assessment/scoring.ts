/**
 * Assessment scoring.
 *
 * Pure functions, no database and no clock, so the rules can be tested
 * directly. Scores are normalised to 0-100 per area and overall, because a raw
 * likert total means nothing to a woman reading her own result.
 *
 * Reverse-scored questions matter: an honest instrument mixes the direction of
 * its statements so that agreeing with everything does not produce a flattering
 * picture.
 */

export type Area = 'herself' | 'relationships' | 'money' | 'success'
export const areas: Area[] = ['herself', 'relationships', 'money', 'success']

/**
 * The four areas, as a woman reads them.
 *
 * These names are the curriculum's, not the database's, and they are the only
 * ones that should ever reach a screen. They live here, beside the type, so
 * that adding an area cannot silently leave a surface rendering a raw enum
 * value.
 */
export const areaLabels: Record<Area, string> = {
  herself: 'Herself',
  relationships: 'Relationships',
  money: 'Money',
  success: 'Success',
}

/** The same four, addressed to her rather than about her. */
export const areaLabelsSecondPerson: Record<Area, string> = {
  herself: 'Yourself',
  relationships: 'Relationships',
  money: 'Money',
  success: 'Success',
}

export type QuestionType = 'likert' | 'multiple_choice' | 'open'

export interface ScorableQuestion {
  id: string
  type: QuestionType
  area: Area | null
  /** { min, max, reverseScored, options: [{ value, score }] } */
  config: {
    min?: number
    max?: number
    reverseScored?: boolean
    options?: Array<{ value: string; score?: number }>
  }
}

export interface Answer {
  questionId: string
  value: unknown
}

export interface AreaScore {
  area: Area
  /** 0-100, or null when she answered nothing in this area. */
  score: number | null
  answered: number
  total: number
}

export interface ScoreResult {
  overall: number | null
  byArea: AreaScore[]
  answered: number
  scorable: number
}

/** Normalise one answer to 0-1, or null when it does not score. */
export function normaliseAnswer(
  question: ScorableQuestion,
  value: unknown,
): number | null {
  if (question.type === 'open') return null
  if (value === null || value === undefined || value === '') return null

  if (question.type === 'likert') {
    const min = question.config.min ?? 1
    const max = question.config.max ?? 5
    if (max <= min) return null

    const raw = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(raw)) return null

    // Out-of-range answers are clamped rather than discarded: a stored answer
    // from an older version of the instrument should still count.
    const clamped = Math.min(max, Math.max(min, raw))
    const unit = (clamped - min) / (max - min)
    return question.config.reverseScored ? 1 - unit : unit
  }

  // multiple_choice
  const options = question.config.options ?? []
  const chosen = options.find((o) => o.value === String(value))
  if (!chosen || chosen.score === undefined) return null

  const scores = options
    .map((o) => o.score)
    .filter((s): s is number => s !== undefined)
  if (scores.length === 0) return null

  const min = Math.min(...scores)
  const max = Math.max(...scores)
  if (max <= min) return null

  const unit = (chosen.score - min) / (max - min)
  return question.config.reverseScored ? 1 - unit : unit
}

const pct = (n: number) => Math.round(n * 100)

export function scoreAssessment(
  questions: ScorableQuestion[],
  answers: Answer[],
): ScoreResult {
  const byId = new Map(answers.map((a) => [a.questionId, a.value]))

  const buckets = new Map<Area, { sum: number; answered: number; total: number }>()
  for (const area of areas) buckets.set(area, { sum: 0, answered: 0, total: 0 })

  let sum = 0
  let answered = 0
  let scorable = 0

  for (const question of questions) {
    if (question.type === 'open') continue
    scorable++

    const bucket = question.area ? buckets.get(question.area) : undefined
    if (bucket) bucket.total++

    const unit = normaliseAnswer(question, byId.get(question.id))
    if (unit === null) continue

    answered++
    sum += unit
    if (bucket) {
      bucket.sum += unit
      bucket.answered++
    }
  }

  return {
    overall: answered > 0 ? pct(sum / answered) : null,
    byArea: areas.map((area) => {
      const b = buckets.get(area)!
      return {
        area,
        score: b.answered > 0 ? pct(b.sum / b.answered) : null,
        answered: b.answered,
        total: b.total,
      }
    }),
    answered,
    scorable,
  }
}

/**
 * The area she is furthest from herself in.
 *
 * Lowest score wins, ties broken by the declared order of areas so the result
 * is deterministic rather than dependent on map iteration.
 */
export function loudestArea(result: ScoreResult): Area | null {
  const scored = result.byArea.filter(
    (a): a is AreaScore & { score: number } => a.score !== null,
  )
  if (scored.length === 0) return null

  return scored.reduce((lowest, current) =>
    current.score < lowest.score ? current : lowest,
  ).area
}

/**
 * What changed between a pre and a post attempt.
 *
 * Returned in points, so "+18 in Wealth" reads the way a woman would say it.
 */
export function compare(pre: ScoreResult, post: ScoreResult) {
  const byArea = areas.map((area) => {
    const before = pre.byArea.find((a) => a.area === area)?.score ?? null
    const after = post.byArea.find((a) => a.area === area)?.score ?? null
    return {
      area,
      before,
      after,
      delta: before !== null && after !== null ? after - before : null,
    }
  })

  return {
    overall: {
      before: pre.overall,
      after: post.overall,
      delta:
        pre.overall !== null && post.overall !== null
          ? post.overall - pre.overall
          : null,
    },
    byArea,
  }
}

import { z } from 'zod'
import type { HerEvidence } from '../../contract'

/**
 * Day 7 — the spoken mirror.
 *
 * Days 1 to 6 she looked in the mirror to FIND something. Today she looks
 * herself in the eyes and SPEAKS AS HER. That is a different act and it needs
 * a different screen.
 *
 * The statements are built from her own six days rather than handed to her
 * generic. A woman reading somebody else's affirmation hears somebody else;
 * a woman reading the sentence she wrote on Day 4 hears herself, which is the
 * entire point of having made her write it.
 *
 * She can edit every line before she begins, and add her own. Nothing here is
 * locked — it is her declaration, not ours.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  /** Statements offered when she has no material to build from. */
  fallbacks: z.array(z.string()).default([]),
  beginLabel: z.string().default('Begin the declaration'),
})

export const responseSchema = z.object({
  /** The final, edited statements, in the order she speaks them. */
  statements: z.array(z.string()).default([]),
  spokenAt: z.string().optional(),
  completed: z.boolean().default(false),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

/**
 * Build her opening statements from her own week.
 *
 * Pure, and exported so it can be tested without a browser: getting this wrong
 * means a woman is handed somebody else's words at the emotional peak of the
 * whole challenge.
 *
 * Only speaks in the first person and the present tense, because she is about
 * to say these out loud as HER.
 */
export function suggestStatements(
  evidence: HerEvidence | undefined,
  fallbacks: string[] = [],
): string[] {
  const out: string[] = []

  for (const pattern of evidence?.patterns ?? []) {
    if (pattern.herResponse?.trim()) {
      out.push(pattern.herResponse.trim())
    }
  }

  const choices = (evidence?.choices ?? []).filter((c) => c.herResponse?.trim())
  for (const choice of choices.slice(0, 3)) {
    out.push(choice.herResponse!.trim())
  }

  if ((evidence?.choiceCount ?? 0) > 0) {
    const n = evidence!.choiceCount
    out.push(
      n === 1
        ? 'I chose her once this week, and I know I can do it again.'
        : `I chose her ${n} times this week. That is not nothing. That is evidence.`,
    )
  }

  // Her own words first, always. These only fill the gaps.
  for (const f of fallbacks) {
    if (out.length >= 8) break
    out.push(f)
  }

  // Deduplicate without reordering: she may have written the same true thing
  // twice, and hearing it twice is not powerful, it is a glitch.
  const seen = new Set<string>()
  return out.filter((s) => {
    const key = s.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

import { z } from 'zod'

/**
 * One concrete thing she will do.
 *
 * Two shapes, because the challenge needs both:
 *
 * - Asked. She writes the action and when. The ordinary case.
 * - Echoed. Days 6 and 7 do not ask again: she has ALREADY written the thing,
 *   one screen ago, and asking a second time would turn the most decisive
 *   moment in the week into data entry. `echoesFrom` names that earlier
 *   answer, the screen shows it large, and one button commits to it. No proof
 *   is required and none is asked for - her confirmation is the whole thing.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  suggestions: z.array(z.string()).default([]),
  /** The name of an earlier answer today to commit to, instead of asking. */
  echoesFrom: z.string().optional(),
  confirmLabel: z.string().default('I am doing it'),
  /** The name later screens on the same day quote this answer by. */
  saveAs: z.string().optional(),
})

export const responseSchema = z.object({
  action: z.string().min(1),
  when: z.string().default(''),
  done: z.boolean().default(false),
  /** When she pressed the button. Day 6 and Day 7 both keep this. */
  confirmedAt: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

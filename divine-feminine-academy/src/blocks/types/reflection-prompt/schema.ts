import { z } from 'zod'

/**
 * An open reflection. Marked sensitive, so the response is encrypted like a
 * journal body and admin surfaces see only that it was answered.
 *
 * Days 2 and 3 reach into origin wounds. Those use this block.
 */
export const configSchema = z.object({
  prompt: z.string(),
  /**
   * The name later screens on the SAME DAY quote this answer by.
   *
   * Day 1 asks what happened and then reads it back before asking what ME
   * did; Day 7 keeps one decision on screen across eight screens. Both work
   * because the answer has a name.
   */
  saveAs: z.string().optional(),
  /** Her own words from an earlier screen today, shown above the prompt. */
  showsEarlier: z.string().optional(),
  showsEarlierLabel: z.string().default(''),
  helper: z.string().optional(),
  placeholder: z.string().optional(),
  minWords: z.number().int().nonnegative().default(0),
  alsoSaveToJournal: z.boolean().default(true),
  /**
   * Day 2 only: a way out that is not quitting.
   *
   * The heaviest day in the challenge asks where ME learned it, and a woman
   * who needs to stop halfway through that should be able to, with her
   * writing kept, without it reading as failure.
   */
  allowStopForToday: z.boolean().default(false),
})

export const responseSchema = z.object({ text: z.string() })

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

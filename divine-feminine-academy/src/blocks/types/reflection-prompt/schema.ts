import { z } from 'zod'

/**
 * An open reflection. Marked sensitive, so the response is encrypted like a
 * journal body and admin surfaces see only that it was answered.
 *
 * Days 2 and 3 reach into origin wounds. Those use this block.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  placeholder: z.string().optional(),
  minWords: z.number().int().nonnegative().default(0),
  alsoSaveToJournal: z.boolean().default(true),
})

export const responseSchema = z.object({ text: z.string() })

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

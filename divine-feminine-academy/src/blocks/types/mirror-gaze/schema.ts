import { z } from 'zod'

/**
 * The mirror, every day.
 *
 * A DAILY practice across all seven days, not one exercise on one day. Each
 * day carries its own intention, tied to that day's work, held on screen while
 * she looks.
 *
 * The config holds the intention rather than the component, because the
 * intention is curriculum and curriculum is edited by the woman whose brand
 * this is, in the admin, without a developer.
 */
export const configSchema = z.object({
  /** The line held on screen while she looks. This is the practice. */
  intention: z.string(),
  helper: z.string().optional(),
  seconds: z.number().int().min(15).max(600).default(60),
  /** Whether to ask for a word afterwards. */
  askAfter: z.boolean().default(true),
  afterPrompt: z.string().default('What came up?'),
})

export const responseSchema = z.object({
  /** How long she actually stayed. The number that matters. */
  secondsCompleted: z.number().int().min(0),
  completed: z.boolean(),
  after: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

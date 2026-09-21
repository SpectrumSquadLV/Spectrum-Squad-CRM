import { z } from 'zod'

/**
 * A moment, built from her own numbers.
 *
 * Day 5 ends in celebration on purpose: recognising that she participates in
 * the pattern is the same thing as recognising she has power over it. That is
 * the good news of the hardest day, and it should land as good news.
 *
 * Display only, and deliberately not confetti. The celebration is her own
 * count read back to her — what she has actually done this week — because a
 * number she earned is worth more than an animation she did not.
 */
export const configSchema = z.object({
  heading: z.string(),
  body: z.string().optional(),
  /** Shown under the numbers. */
  footnote: z.string().optional(),
  showChoices: z.boolean().default(true),
  showDays: z.boolean().default(true),
  showWords: z.boolean().default(true),
})

export type Config = z.infer<typeof configSchema>

import { z } from 'zod'

/**
 * Day 2 — MEET YOUR PROTECTOR.
 *
 * ME is not the enemy. This is the day that establishes it: what she was
 * protecting, what she was afraid would happen, and what it cost her to do
 * the job. A woman cannot retire somebody she has not first understood.
 *
 * Sensitive. Some of these answers are about the worst thing that ever
 * happened to her.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  protectingLabel: z.string().default('What she has been protecting'),
  fearLabel: z.string().default('What she was afraid would happen'),
  firstLabel: z.string().default('When she first took the job'),
  costLabel: z.string().default('What the job has cost her'),
})

export const responseSchema = z.object({
  protecting: z.string().min(1),
  fear: z.string(),
  first: z.string(),
  cost: z.string(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

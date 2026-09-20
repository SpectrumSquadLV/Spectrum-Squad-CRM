import { z } from 'zod'

/**
 * Day 7: her HER Code.
 *
 * This is the growth loop. If it is beautiful enough to screenshot and post,
 * acquisition gets much cheaper — so it is a marketing asset, not the last
 * screen of a challenge.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  lineCount: z.number().int().min(1).max(10).default(5),
  linePlaceholder: z.string().default('I am the woman who…'),
})

export const responseSchema = z.object({
  lines: z.array(z.string()),
  declaration: z.string(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

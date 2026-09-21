import { z } from 'zod'
import { areas } from '@/features/assessment/scoring'

/**
 * The four life areas, as four large tiles.
 *
 * Day 4 asks her to look at ONE area rather than her whole life, because
 * "look around at your life" with no frame is how a woman ends up cataloguing
 * everything that has ever gone wrong. One area, one honest look, then an
 * offer to look at another if she wants to.
 */
export const configSchema = z.object({
  prompt: z.string().default('Where do you want to look?'),
  helper: z.string().optional(),
  /** After she has finished with one, offer another. Day 4 does. */
  allowAnother: z.boolean().default(true),
})

export const responseSchema = z.object({
  area: z.enum(areas as [string, ...string[]]),
  /** Areas she has already worked through, if she chose to look at more. */
  alsoExplored: z.array(z.string()).default([]),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

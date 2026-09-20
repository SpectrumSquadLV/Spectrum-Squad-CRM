import { z } from 'zod'

/**
 * Day 5: the RETURN practice.
 *
 * She reaches this on a bad day, at low capacity. Whatever is built on it stays
 * large, calm and short. It is also the one practice she keeps for life, so the
 * same shape backs the standalone /my-practice/return page.
 */
export const returnActions = [
  'dance',
  'create',
  'move',
  'music',
  'nature',
  'play',
  'rest',
  'connect',
  'journal',
  'custom',
] as const

export const configSchema = z.object({
  prompt: z.string().default('Come back to yourself.'),
  helper: z.string().optional(),
  /** Day 5 teaches the practice; the standalone page just runs it. */
  teaching: z.boolean().default(false),
})

export const responseSchema = z.object({
  whatHappened: z.string(),
  feeling: z.string(),
  meaningMade: z.string(),
  isItTrue: z.string(),
  whatINeed: z.string(),
  actionChosen: z.enum(returnActions).optional(),
  customAction: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>
export type ReturnAction = (typeof returnActions)[number]

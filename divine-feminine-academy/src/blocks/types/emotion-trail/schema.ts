import { z } from 'zod'

/**
 * Day 3 — FOLLOW THE EMOTION.
 *
 * The trigger, followed BACKWARD, in the order the methodology sets out:
 *
 *   event → emotion → reaction → what she was protecting →
 *   earlier experience → what she learned and began believing about herself
 *
 * Six steps, in that order, because the order is the method. Starting at the
 * belief would be asking her to already know the answer; starting at the event
 * means the belief arrives as something she found rather than something she
 * was told.
 *
 * The last field is the one Day 4 picks up.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  eventLabel: z.string().default('What happened'),
  emotionLabel: z.string().default('What you felt'),
  reactionLabel: z.string().default('What you did'),
  protectingLabel: z.string().default('What you were protecting'),
  earlierLabel: z.string().default('When you felt this before'),
  beliefLabel: z.string().default('What you learned about yourself'),
})

export const responseSchema = z.object({
  event: z.string().min(1),
  emotion: z.string(),
  reaction: z.string(),
  protecting: z.string(),
  earlier: z.string(),
  belief: z.string(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

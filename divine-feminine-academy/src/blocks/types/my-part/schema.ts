import { z } from 'zod'

/**
 * Day 5 — THE PROBLEM IS YOU.
 *
 * The most confronting title in the challenge, and the one that has to be
 * handled most carefully. "The problem is you" is a liberating sentence only
 * when it means "the part I can reach is mine" — and a damaging one if it is
 * allowed to mean "what happened to you was your doing".
 *
 * The methodology is explicit about this, so the block is built around the
 * distinction rather than leaving it to a prompt somebody might reword:
 * she is asked what is NOT hers first, and only then what is.
 *
 * That ordering is the whole design. Naming what she is not responsible for
 * is what makes it safe to look at what she is.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  notMineLabel: z
    .string()
    .default('What was never yours to carry'),
  mineLabel: z.string().default('The part that does belong to you'),
  reachLabel: z.string().default('What you could reach, if you wanted to'),
})

export const responseSchema = z.object({
  notMine: z.string().min(1),
  mine: z.string(),
  reach: z.string(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

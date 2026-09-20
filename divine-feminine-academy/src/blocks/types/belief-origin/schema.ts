import { z } from 'zod'

/**
 * Day 2: where the belief started.
 *
 * This is the block that asks a woman where she first learned she was not
 * worthy of love. Some will write about abuse. It is marked sensitive, so the
 * response is encrypted exactly like a journal body, and it renders crisis
 * resources on the page because nobody here is monitoring what she writes.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  beliefLabel: z.string().default('The belief'),
  originLabel: z.string().default('Where you first learned it'),
  costLabel: z.string().default('What believing it has cost you'),
  rewriteLabel: z.string().default('What HER knows instead'),
})

export const responseSchema = z.object({
  belief: z.string().min(1),
  origin: z.string(),
  cost: z.string(),
  rewrite: z.string(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

import { z } from 'zod'

/**
 * Day 1 — MEET ME.
 *
 * ME is the version of her whose job has been to make her feel good enough.
 * This names her, in ME's own language, from the list in the methodology:
 * defend, control, withdraw, escape, prove, seek validation, distract, cut
 * off, question herself, avoid, keep score, manage how she is seen.
 *
 * Her quiz archetype arrives pre-filled when she has one. She is not asked to
 * meet the same woman twice.
 */
export const STRATEGIES = [
  'defend',
  'control',
  'withdraw',
  'escape',
  'prove myself',
  'seek validation',
  'distract myself',
  'cut people off',
  'question myself',
  'avoid it',
  'keep score',
  'manage how I am seen',
] as const

export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  nameLabel: z.string().default('What you will call her'),
  triggerLabel: z.string().default('What sets her off'),
  strategiesLabel: z.string().default('What she does'),
})

export const responseSchema = z.object({
  /** Her own name for ME. Pre-filled from her archetype when she has one. */
  name: z.string().min(1),
  trigger: z.string().min(1),
  strategies: z.array(z.string()).default([]),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

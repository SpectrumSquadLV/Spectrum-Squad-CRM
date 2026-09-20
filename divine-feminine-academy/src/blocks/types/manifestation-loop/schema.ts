import { z } from 'zod'

/**
 * Day 4 — REVIEW THE BELIEF.
 *
 * The loop from the methodology, walked with her own example:
 *
 *   Experience → Meaning → Belief → Expectation → Attention → Evidence →
 *   Stronger Belief → repeat
 *
 * One field per step, one step per screen. Seven boxes on one page is a wall;
 * seven screens is a story she is telling herself out loud, which is the
 * point.
 *
 * The framing line above it is NOT editable and NOT optional. See the
 * component for why.
 */
export const LOOP_STEPS = [
  { key: 'experience', label: 'Something happened' },
  { key: 'meaning', label: 'What you made it mean' },
  { key: 'belief', label: 'What you came to believe' },
  { key: 'expectation', label: 'What you began to expect' },
  { key: 'attention', label: 'What you started noticing' },
  { key: 'evidence', label: 'What you found' },
  { key: 'stronger', label: 'What you thought when you found it' },
] as const

export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  /** Optional per-step overrides; the defaults above are used otherwise. */
  labels: z.record(z.string(), z.string()).optional(),
})

export const responseSchema = z.object({
  experience: z.string().min(1),
  meaning: z.string(),
  belief: z.string(),
  expectation: z.string(),
  attention: z.string(),
  evidence: z.string(),
  stronger: z.string(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

import { z } from 'zod'

/**
 * Day 4 — REVIEW THE BELIEF.
 *
 * The belief Day 3 surfaced, put on trial:
 *
 *   Where did it come from? What supports it? What contradicts it?
 *   Does it move me closer to HER or further away?
 *   Am I carrying it, or letting it go?
 *
 * The evidence-against field matters more than the others and is deliberately
 * the largest. A woman who has believed something for thirty years can list
 * the evidence for it in seconds; the against column is the one she has never
 * been asked to write, and it is the whole work of the day.
 *
 * The last question is a real choice, not a rhetorical one. She is allowed to
 * say she is keeping it — a belief she is not ready to put down is not a
 * failure, and a forced answer would only teach her to lie to the page.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  beliefLabel: z.string().default('The belief'),
  originLabel: z.string().default('Where it came from'),
  forLabel: z.string().default('What seems to prove it'),
  againstLabel: z.string().default('What contradicts it'),
  directionLabel: z
    .string()
    .default('Does believing it take you closer to HER, or further away?'),
})

export const responseSchema = z.object({
  belief: z.string().min(1),
  origin: z.string(),
  evidenceFor: z.string(),
  evidenceAgainst: z.string(),
  direction: z.enum(['closer', 'further', 'not sure']).default('not sure'),
  /** The real choice. */
  verdict: z.enum(['carrying', 'releasing', 'not yet']).default('not yet'),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

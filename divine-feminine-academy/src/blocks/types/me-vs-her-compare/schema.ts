import { z } from 'zod'

/**
 * ME and HER, side by side, on the same decision.
 *
 * The biggest visual moment of the challenge. Everything before Day 7 built
 * toward a woman looking at one real decision and seeing two different
 * answers to it in her own handwriting.
 *
 * Display only. It composes what she wrote on the four screens before it and
 * asks her for nothing.
 */
export const configSchema = z.object({
  /** Names the earlier screens saved under. */
  decisionFrom: z.string().default('decision'),
  meWouldFrom: z.string().default('me_would'),
  meWhyFrom: z.string().default('me_why'),
  herWouldFrom: z.string().default('her_would'),
  herWhyFrom: z.string().default('her_why'),
  meLabel: z.string().default('ME'),
  herLabel: z.string().default('HER'),
  /** The four lines under the comparison. */
  close: z.string().default(''),
})

export type Config = z.infer<typeof configSchema>

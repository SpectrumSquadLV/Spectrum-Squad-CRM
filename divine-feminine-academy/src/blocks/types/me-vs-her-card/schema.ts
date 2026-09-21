import { z } from 'zod'

/**
 * The ME VS. HER card.
 *
 * The challenge's organic sharing moment, and the one artefact that leaves
 * the product. Two rules follow from that:
 *
 *  - She can edit every line before she saves it, because it may be shared
 *    and the version she wrote at 11pm on Day 7 is not always the version she
 *    wants public.
 *  - Nothing is EVER shared automatically. Saving an image to her phone and
 *    posting it are two different decisions and only she makes the second.
 */
export const configSchema = z.object({
  heading: z.string().default('ME VS. HER'),
  decisionFrom: z.string().default('decision'),
  /** The card's "why" is her ME why, from Screen 4. */
  whyFrom: z.string().default('me_why'),
  meWouldFrom: z.string().default('me_would'),
  herWouldFrom: z.string().default('her_would'),
  /** Names the choice_capture block saved under, for WHO AM I CHOOSING. */
  choiceFrom: z.string().default('who_chosen'),
  footer: z.string().default('I AM WORTHY OF EVERYTHING I DESIRE.'),
})

export const responseSchema = z.object({
  /** Her edits, by line. Empty means "use what I wrote earlier". */
  edits: z.record(z.string(), z.string()).default({}),
  savedAt: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

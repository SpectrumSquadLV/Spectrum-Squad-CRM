import { z } from 'zod'

/**
 * One sentence, part written for her and part written by her.
 *
 * Day 3's close:
 *
 *   ME, I see you.
 *   You learned to [Day 1 behaviour] because I needed [Day 2 unmet need].
 *   You were trying to protect me from ____.
 *   Thank you for ____.
 *   I am not ____.
 *   I am HER.
 *
 * The two bracketed parts are filled from what she already told us and shown
 * as editable text, never as empty blanks — a woman who has spent two days
 * getting here should not arrive to find the form has forgotten her. The
 * three underscored parts she types, inline, so the whole thing reads as one
 * sentence while she writes it.
 */
export const segmentSchema = z.discriminatedUnion('kind', [
  /** Fixed copy. */
  z.object({ kind: z.literal('text'), text: z.string() }),
  /**
   * A blank she fills. `name` is the key it saves under, so each blank is
   * stored separately rather than as one blob.
   */
  z.object({
    kind: z.literal('blank'),
    name: z.string(),
    placeholder: z.string().default(''),
    /**
     * Pre-filled from what she has already said:
     *  - `behaviorTags`: Day 1's tags, in "you" form
     *  - `unmetNeed`: Day 2's answer
     * She can edit whatever arrives. Empty when she skipped that day.
     */
    prefillFrom: z.enum(['behaviorTags', 'unmetNeed']).optional(),
  }),
])

export const configSchema = z.object({
  heading: z.string().optional(),
  segments: z.array(segmentSchema).default([]),
  /** The button that finishes the day. Day 3's is "This is true". */
  confirmLabel: z.string().default('This is true'),
})

export const responseSchema = z.object({
  /** Each blank by name, so nothing is stored as one undifferentiated blob. */
  blanks: z.record(z.string(), z.string()).default({}),
  confirmedAt: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

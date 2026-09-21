import { z } from 'zod'

/**
 * The mirror, on six of the seven days.
 *
 * Days 1 to 6 each end at a mirror, and Day 7 deliberately does not: the last
 * day ends in a decision and an action, not in another look.
 *
 * The timer climbs across the week - 1, 2, 2, 3, 3, 3 minutes - and the WORDS
 * that set it up are not in this block at all. Each mirror is preceded by its
 * own screen of copy, because what she is looking FOR changes every day, and
 * because the timer itself has to be silent.
 */
export const configSchema = z.object({
  seconds: z.number().int().min(15).max(900).default(60),
  /**
   * Shown before she starts, and never during.
   *
   * The curriculum puts the real setup copy on the screen before this one.
   * This is only the line on the button's own screen, if a day wants one.
   */
  intention: z.string().default(''),
  /** How long ONE MORE MINUTE adds. */
  extendSeconds: z.number().int().min(15).max(300).default(60),
  /** Off by default. Silence is the design. */
  ambientAudio: z.boolean().default(false),
  /** Day 5's mirror is lighter and more expansive than Days 1-4. */
  mood: z.enum(['still', 'open']).default('still'),
})

export const responseSchema = z.object({
  /** How long she actually stayed, across the first run and any extensions. */
  secondsCompleted: z.number().int().min(0),
  completed: z.boolean(),
  /** How many times she chose ONE MORE MINUTE. */
  extensions: z.number().int().min(0).default(0),
  /** True when she used the quiet way out. Never treated as a failure. */
  stoppedEarly: z.boolean().default(false),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

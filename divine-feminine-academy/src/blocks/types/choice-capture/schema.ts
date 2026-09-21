import { z } from 'zod'

/**
 * WHO ARE YOU CHOOSING?
 *
 * Day 7's hinge, and the block with the most rules attached to it, all of
 * which exist to protect the same thing: the choice has to be REAL.
 *
 *  - ME and HER are equal buttons. Neither is preselected, neither is styled
 *    as the right one.
 *  - Choosing ME is allowed. It shows the comparison once more and lets her
 *    choose again, then continues with no shame if she stays with ME.
 *  - The system never suggests what HER would do. That came from her.
 *
 * A challenge that forces the HER button teaches a woman to perform an
 * answer, which is the exact habit the seven days are trying to interrupt.
 */
export const configSchema = z.object({
  prompt: z.string().default('WHO ARE YOU CHOOSING?'),
  meLabel: z.string().default('ME'),
  herLabel: z.string().default('HER'),
  /** Shown when she chooses ME. Never a rebuke. */
  meResponse: z.string().default(''),
  /** The button under that copy, offering one more look. */
  lookAgainLabel: z.string().default('Look at both again'),
  /** And the one that continues with ME, without argument. */
  continueWithMeLabel: z.string().default('Continue with ME'),
})

export const responseSchema = z.object({
  chosen: z.enum(['me', 'her']).nullable().default(null),
  /**
   * True once she has confirmed ME after seeing both a second time.
   *
   * Kept separate from `chosen` so that "she tapped ME and then chose HER"
   * and "she tapped ME and meant it" are different facts. Day 7's follow-up
   * email opens differently for each, and collapsing them would put the wrong
   * sentence in a woman's inbox.
   */
  confirmed: z.boolean().default(false),
  chosenAt: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

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
  /** The name later screens on the same day quote this answer by. */
  saveAs: z.string().optional(),
  /**
   * The earlier answers this choice is ABOUT.
   *
   * "You've chosen HER n times" is the metric the whole platform is built
   * around, and a row that records only the word "her" cannot tell her what
   * she chose or when it mattered. So the decision and both answers travel
   * with the choice into her HER profile.
   */
  decisionFrom: z.string().default('decision'),
  meWouldFrom: z.string().default('me_would'),
  herWouldFrom: z.string().default('her_would'),
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
  /** Carried for her HER profile. See `decisionFrom` above. */
  situation: z.string().default(''),
  oldResponse: z.string().default(''),
  herResponse: z.string().default(''),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

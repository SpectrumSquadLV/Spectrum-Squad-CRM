import { z } from 'zod'

/**
 * Quiana speaking, before a mirror.
 *
 * The words are NOT in this config. They live in
 * src/features/challenge/founder-notes.ts, and this block holds only the key
 * that selects one.
 *
 * That is deliberate. Config is written into the database by the seed, so
 * copy stored here would be frozen into a published version and editing it
 * would mean a migration or a re-seed for a comma. Keeping her voice in a
 * source file means she can change a word, redeploy, and every woman mid-
 * challenge sees the new wording — which is the right behaviour for a note
 * FROM her, and the wrong behaviour for the day's instructions, which must
 * never shift under a woman who is part-way through them.
 */
export const configSchema = z.object({
  /** Selects a note from founder-notes.ts. */
  note: z.string().min(1),
  /**
   * Show her photograph beside the note.
   *
   * On by default: the point of this block is that a person is speaking, and
   * a face does more for that in one second than the paragraphs do. Off is
   * for a day where a second portrait would be one too many.
   */
  portrait: z.boolean().default(true),
})

export type Config = z.infer<typeof configSchema>

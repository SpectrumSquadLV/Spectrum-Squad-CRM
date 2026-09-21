import { z } from 'zod'
import { areas } from '@/features/assessment/scoring'

/**
 * THIS IS HER.
 *
 * Day 5's signature screen: the four things she just allowed herself to want,
 * read back to her on one page. It is display AND storage at once — the four
 * answers arrive here from the four screens before it, and this is the block
 * that writes them to her_desires, where every later day and the Academy read
 * them from.
 *
 * `readsFrom` names the four earlier screens by the name each saved under.
 */
const areaKeys = areas as [string, ...string[]]

export const configSchema = z.object({
  heading: z.string().default('THIS IS HER.'),
  /** Which earlier answer belongs to which area. */
  readsFrom: z.record(z.enum(areaKeys), z.string()).default({}),
  /** The lines under the four. Day 5's are about permission, not effort. */
  close: z.string().default(''),
})

export const responseSchema = z.object({
  /** The four, by area, as they were when she saw them. */
  desires: z.record(z.enum(areaKeys), z.string()).default({}),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

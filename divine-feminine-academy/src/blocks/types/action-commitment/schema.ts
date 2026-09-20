import { z } from 'zod'

/** One concrete thing she will do, with a when. */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  suggestions: z.array(z.string()).default([]),
})

export const responseSchema = z.object({
  action: z.string().min(1),
  when: z.string(),
  done: z.boolean().default(false),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

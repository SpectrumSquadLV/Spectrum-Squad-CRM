import { z } from 'zod'

/** Day 4: one behaviour she keeps repeating that HER would not. */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
})

export const responseSchema = z.object({
  behaviour: z.string().min(1),
  instead: z.string().min(1),
  /** Specific enough to be checkable. Vagueness is how this fails. */
  nextTime: z.string(),
  area: z.enum(['herself', 'relationships', 'success', 'money']).optional(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

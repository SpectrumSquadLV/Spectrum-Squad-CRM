import { z } from 'zod'

/** A prompted free write that lands in her journal. Encrypted. */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  placeholder: z.string().optional(),
  area: z.enum(['herself', 'relationships', 'success', 'money']).optional(),
})

export const responseSchema = z.object({
  title: z.string().optional(),
  text: z.string(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

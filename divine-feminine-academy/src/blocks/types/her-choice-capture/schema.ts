import { z } from 'zod'

/**
 * Day 6: I CHOSE HER.
 *
 * The core metric of the whole platform. She logs these in the moment, from her
 * phone, all day — so the capture form has to be as fast as a notes app.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
})

export const responseSchema = z.object({
  situation: z.string().min(1),
  oldResponse: z.string(),
  herResponse: z.string().min(1),
  reflection: z.string().optional(),
  area: z.enum(['self', 'love', 'life', 'wealth']).optional(),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

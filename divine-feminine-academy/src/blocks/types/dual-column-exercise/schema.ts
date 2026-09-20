import { z } from 'zod'

/**
 * Day 1: Current Me / HER.
 *
 * Schemas live in their own module so both the server-side definition and the
 * client-side component can import them without either one dragging the other
 * across the client boundary.
 */
export const configSchema = z.object({
  prompt: z.string(),
  triggerLabel: z.string().default('What sets this off?'),
  currentLabel: z.string().default('Current Me responds by...'),
  herLabel: z.string().default('HER responds by...'),
  helper: z.string().optional(),
})

export const responseSchema = z.object({
  trigger: z.string().min(1),
  currentResponse: z.string().min(1),
  herResponse: z.string().min(1),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

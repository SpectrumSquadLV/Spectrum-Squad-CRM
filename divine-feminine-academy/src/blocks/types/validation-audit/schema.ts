import { z } from 'zod'

/** Day 3: whose approval is she still arranging her life around. */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  minEntries: z.number().int().min(1).default(3),
})

export const auditRowSchema = z.object({
  whose: z.string(),
  what: z.string(),
  ifTheyDisapproved: z.string(),
})

export const responseSchema = z.object({
  rows: z.array(auditRowSchema),
  realisation: z.string(),
})

export type Config = z.infer<typeof configSchema>
export type AuditRow = z.infer<typeof auditRowSchema>
export type Response = z.infer<typeof responseSchema>

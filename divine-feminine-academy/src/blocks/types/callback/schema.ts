import { z } from 'zod'

/**
 * Her own words, handed back on a later day.
 *
 * Display only. This is the cheapest block in the whole challenge and it does
 * more than most of the expensive ones: it is what turns seven separate days
 * into one week that was paying attention.
 *
 * It shows nothing new. That is the point — a woman on Day 5 reading the
 * sentence she wrote on Day 1 is having an experience no PDF can give her.
 */
export const FACETS = [
  'trigger',
  'me_response',
  'her_response',
  'choices',
  /** Her four Day 5 desires. Day 6 reads them back before she chooses. */
  'desires',
] as const

export const configSchema = z.object({
  /** Which part of her week to read back. */
  facet: z.enum(FACETS).default('trigger'),
  heading: z.string().default('You wrote this earlier'),
  /** Shown when she has nothing yet — a first-time taker, or a skipped day. */
  emptyText: z.string().default(''),
  /**
   * Day 6 shows her desires collapsed, because the screen's job is ONE small
   * choice and four paragraphs of what she wants would swamp it. She taps to
   * open them.
   */
  collapsed: z.boolean().default(false),
})

export type Config = z.infer<typeof configSchema>

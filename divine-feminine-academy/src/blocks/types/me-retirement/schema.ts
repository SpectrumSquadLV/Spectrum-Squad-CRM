import { z } from 'zod'

/**
 * Day 7 — retiring ME.
 *
 * The emotional closeout, and the four sentences the methodology is explicit
 * about. They are defaults in config so they can be reworded, but they arrive
 * in the right order and with the right meaning:
 *
 *   I understand you. I love you. Thank you for protecting me.
 *   You do not have to do this job any more.
 *
 * This is NOT a rejection. ME was not bad. ME's job was to make her feel good
 * enough, and she did it for years. HER's job is different: to live knowing
 * she already is.
 *
 * She has to tick each one. Not as a form gate — because saying them one at a
 * time, deliberately, is the ceremony. A single "complete" button would make
 * it an errand.
 */
export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  understand: z.string().default('I understand you.'),
  love: z.string().default('I love you.'),
  thank: z.string().default('Thank you for protecting me.'),
  release: z.string().default('You do not have to do this job any more.'),
  letterLabel: z
    .string()
    .default('Anything else you want to say to her'),
  finalLabel: z.string().default('HER LEADS NOW'),
})

export const responseSchema = z.object({
  understood: z.boolean().default(false),
  loved: z.boolean().default(false),
  thanked: z.boolean().default(false),
  released: z.boolean().default(false),
  letter: z.string().optional(),
  /** Drives the retirement side effect. */
  retire: z.boolean().default(false),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

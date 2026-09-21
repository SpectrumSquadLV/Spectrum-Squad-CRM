import { z } from 'zod'
import { areas } from '@/features/assessment/scoring'

/**
 * Tappable behaviours, multi-select, plus write-your-own.
 *
 * Used twice, in two different shapes:
 *
 * - Day 1 offers ONE flat list of ME behaviours and asks her to tap anything
 *   she has caught herself doing. No score, no result.
 * - Day 4 offers a list PER AREA, and shows the list for whichever area she
 *   picked on the screen before.
 *
 * So `options` carries the flat list and `optionsByArea` the per-area ones;
 * a block sets whichever it needs. `readsArea` names the earlier block whose
 * chosen area decides which list to show.
 */
const areaKeys = areas as [string, ...string[]]

export const configSchema = z.object({
  prompt: z.string(),
  helper: z.string().optional(),
  /** The flat list. Day 1. */
  options: z.array(z.string()).default([]),
  /** One list per area. Day 4. */
  optionsByArea: z.record(z.enum(areaKeys), z.array(z.string())).optional(),
  /** The name an earlier area_picker saved under, when lists are per-area. */
  readsArea: z.string().optional(),
  allowCustom: z.boolean().default(true),
  customLabel: z.string().default('Write my own'),
})

export const responseSchema = z.object({
  /** The phrases she tapped, exactly as they were offered. */
  selected: z.array(z.string()).default([]),
  /** Anything she wrote that was not on the list. */
  custom: z.string().default(''),
})

export type Config = z.infer<typeof configSchema>
export type Response = z.infer<typeof responseSchema>

/** Day 5 - MEET HER. THIS IS HER. */
import type { BlockDefinition } from '../../contract'
import { HerRevealMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const herReveal: BlockDefinition<typeof configSchema, Response> = {
  type: 'her_reveal',
  label: 'THIS IS HER',
  description:
    'Her four Day 5 desires, read back on one screen. Writes them to her HER profile.',
  configSchema,
  responseSchema,
  Member: HerRevealMember,
  isSensitive: true,
  writesTo: ['her_desires'],
}

/** Day 1 — MEET ME. */
import type { BlockDefinition } from '../../contract'
import { MePortraitMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const mePortrait: BlockDefinition<typeof configSchema, Response> = {
  type: 'me_portrait',
  label: 'Meet ME',
  description:
    'Names ME and the strategies she uses, in ME\'s own language. Pre-filled from her quiz archetype.',
  configSchema,
  responseSchema,
  Member: MePortraitMember,
  isSensitive: false,
  writesTo: ['her_patterns'],
}

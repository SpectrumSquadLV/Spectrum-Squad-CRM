/** Day 7 - the card she takes with her. */
import type { BlockDefinition } from '../../contract'
import { MeVsHerCardMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const meVsHerCard: BlockDefinition<typeof configSchema, Response> = {
  type: 'me_vs_her_card',
  label: 'ME VS. HER card',
  description:
    'The shareable card. Every line editable before she keeps it; nothing is shared automatically.',
  configSchema,
  responseSchema,
  Member: MeVsHerCardMember,
  isSensitive: true,
}

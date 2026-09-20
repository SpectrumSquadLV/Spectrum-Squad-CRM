/** Day 5 — THE PROBLEM IS YOU. */
import type { BlockDefinition } from '../../contract'
import { MyPartMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const myPart: BlockDefinition<typeof configSchema, Response> = {
  type: 'my_part',
  label: 'The part that is yours',
  description:
    'What was never hers to carry, and only then the part that is. Carries fixed duty-of-care framing. Encrypted.',
  configSchema,
  responseSchema,
  Member: MyPartMember,
  isSensitive: true,
  writesTo: ['journal_entries'],
}

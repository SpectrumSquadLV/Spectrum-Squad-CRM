/** Day 5, and the standalone practice she keeps for life. */
import type { BlockDefinition } from '../../contract'
import { ReturnPracticeMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const returnPractice: BlockDefinition<typeof configSchema, Response> = {
  type: 'return_practice',
  label: 'RETURN practice',
  description:
    'Six questions and one action, for the days she loses her. Writes a RETURN session.',
  configSchema,
  responseSchema,
  Member: ReturnPracticeMember,
  isSensitive: true,
  writesTo: ['return_sessions'],
}

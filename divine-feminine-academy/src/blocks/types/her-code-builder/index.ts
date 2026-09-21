/** Day 7. Produces the HER Code — the shareable artefact and the growth loop. */
import type { BlockDefinition } from '../../contract'
import { HerCodeBuilderMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const herCodeBuilder: BlockDefinition<typeof configSchema, Response> = {
  type: 'her_code_builder',
  label: 'HER Code',
  description: 'The code she is living by now. Shareable, and hers to keep.',
  configSchema,
  responseSchema,
  Member: HerCodeBuilderMember,
  isSensitive: false,
  writesTo: ['her_codes'],
}

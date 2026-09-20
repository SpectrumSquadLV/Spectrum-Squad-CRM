/** Day 6, and the standalone I CHOSE HER capture. */
import type { BlockDefinition } from '../../contract'
import { HerChoiceCaptureMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const herChoiceCapture: BlockDefinition<typeof configSchema, Response> = {
  type: 'her_choice_capture',
  label: 'I CHOSE HER',
  description: 'One moment she chose HER instead. The core metric.',
  configSchema,
  responseSchema,
  Member: HerChoiceCaptureMember,
  isSensitive: false,
  writesTo: ['her_choices'],
}

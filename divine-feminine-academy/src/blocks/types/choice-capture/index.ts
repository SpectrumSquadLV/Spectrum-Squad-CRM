/** Day 7 - THE CHOICE. */
import type { BlockDefinition } from '../../contract'
import { ChoiceCaptureMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const choiceCapture: BlockDefinition<typeof configSchema, Response> = {
  type: 'choice_capture',
  label: 'Who are you choosing?',
  description:
    'Two equal buttons, ME and HER, with a no-shame path when she chooses ME.',
  configSchema,
  responseSchema,
  Member: ChoiceCaptureMember,
  isSensitive: true,
  writesTo: ['her_choices'],
}
